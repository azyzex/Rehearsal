import { DatabaseAdapter } from '../adapters/types';
import { Edit, quoteIdentifier } from './changeset';

/**
 * The migration that undoes this one.
 *
 * Every migration tool asks for a down migration and almost nobody writes an
 * honest one, because writing it means knowing what the schema looked like
 * before — and by the time you are writing it, you are looking at the schema
 * after. So the down migration gets guessed, committed, never run, and is
 * wrong on the one night it matters.
 *
 * This is generated before the change, against the live schema, so it knows
 * the column's real type and its real default rather than the ones in the
 * migration file. Where a change cannot be undone at all, it says so instead of
 * emitting something that looks like it would work: a DROP COLUMN takes the
 * values with it, and no ALTER brings them back. That is what the rescue file
 * in `rescue.ts` is for, and the two are meant to be read together.
 */

export interface DownMigration {
  /** Statements that reverse the change, in the order they must run. */
  readonly statements: readonly string[];
  /**
   * What this cannot undo, in plain words.
   *
   * A down migration with gaps is still worth having. One that hides them is
   * worse than none, because it will be trusted.
   */
  readonly gaps: readonly string[];
  /** The whole thing as a file, gaps included as comments. */
  readonly sql: string;
}

export async function downMigration(
  adapter: DatabaseAdapter,
  edits: readonly Edit[],
): Promise<DownMigration> {
  const statements: string[] = [];
  const gaps: string[] = [];

  // Reversed: undoing a sequence means undoing the last thing first. A down
  // migration that runs in the original order will try to drop a column from a
  // table it has not recreated yet.
  for (const edit of [...edits].reverse()) {
    const reversal = await reverse(adapter, edit);
    statements.push(...reversal.statements);
    gaps.push(...reversal.gaps);
  }

  return { statements, gaps, sql: render(statements, gaps) };
}

interface Reversal {
  statements: string[];
  gaps: string[];
}

const NOTHING: Reversal = { statements: [], gaps: [] };

async function reverse(adapter: DatabaseAdapter, edit: Edit): Promise<Reversal> {
  const table = 'table' in edit ? quoteIdentifier(edit.table) : '';

  switch (edit.kind) {
    case 'add_column':
      return only(`ALTER TABLE ${table} DROP COLUMN ${quoteIdentifier(edit.column)}`);

    case 'drop_column': {
      // The column can be put back. Its contents cannot, and saying so is the
      // whole point of the gaps list.
      const column = await columnOf(adapter, edit.table, edit.column);
      if (!column) {
        return {
          statements: [],
          gaps: [
            `Could not read ${edit.table}.${edit.column} before it was dropped, so this ` +
              `cannot be recreated at all.`,
          ],
        };
      }

      // Dropping a serial column drops the sequence it owns, so putting the
      // column back with a nextval default would point at nothing. Written as
      // a serial, it brings its sequence back with it.
      const parts = [
        `ALTER TABLE ${table} ADD COLUMN ${quoteIdentifier(column.name)} ${serialType(column)}`,
      ];
      if (column.identity) {
        parts.push(
          `GENERATED ${column.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`,
        );
      } else if (column.defaultExpression && !isSequenceDefault(column.defaultExpression)) {
        parts.push(`DEFAULT ${column.defaultExpression}`);
      }
      // NOT NULL is deliberately left off: the column comes back empty, and a
      // NOT NULL on an empty column fails on the first row. It is restored
      // after the rescue file has been run, not before.
      return {
        statements: [parts.join(' ')],
        gaps: [
          `${edit.table}.${edit.column} comes back empty. The values are in the rescue ` +
            `file; run that before restoring any NOT NULL on it.`,
        ],
      };
    }

    case 'rename_column':
      return only(
        `ALTER TABLE ${table} RENAME COLUMN ${quoteIdentifier(edit.to)} ` +
          `TO ${quoteIdentifier(edit.column)}`,
      );

    case 'rename_table':
      return only(`ALTER TABLE ${quoteIdentifier(edit.to)} RENAME TO ${bare(edit.table)}`);

    case 'alter_type': {
      const column = await columnOf(adapter, edit.table, edit.column);
      if (!column) {
        return { statements: [], gaps: [`Could not read the type of ${edit.table}.${edit.column}.`] };
      }
      return {
        statements: [
          `ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(edit.column)} ` +
            `TYPE ${column.type}`,
        ],
        gaps: narrowing(column.type, edit.to)
          ? [
              `${edit.table}.${edit.column} was widened from ${column.type} to ${edit.to}; ` +
                `going back is a narrowing cast and will fail on anything that no longer fits.`,
            ]
          : [
              `Casting ${edit.table}.${edit.column} back to ${column.type} restores the type, ` +
                `not the values a narrowing cast rounded or truncated.`,
            ],
      };
    }

    case 'set_nullability':
      return only(
        `ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(edit.column)} ` +
          `${edit.nullable ? 'SET' : 'DROP'} NOT NULL`,
      );

    case 'set_default': {
      const column = await columnOf(adapter, edit.table, edit.column);
      const previous = column?.defaultExpression;
      return only(
        previous
          ? `ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(edit.column)} ` +
              `SET DEFAULT ${previous}`
          : `ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(edit.column)} DROP DEFAULT`,
      );
    }

    case 'add_index': {
      const name = edit.name ?? defaultIndexName(edit.table, edit.columns);
      return only(
        `DROP INDEX ${edit.concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ${quoteIdentifier(name)}`,
      );
    }

    case 'add_unique':
      return only(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ` +
          `${quoteIdentifier(edit.name ?? defaultConstraintName(edit.table, edit.columns, 'key'))}`,
      );

    case 'add_foreign_key':
      return only(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ` +
          `${quoteIdentifier(edit.name ?? defaultConstraintName(edit.table, edit.columns, 'fkey'))}`,
      );

    case 'add_check':
      return edit.name
        ? only(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(edit.name)}`)
        : {
            statements: [],
            gaps: [
              `The check added to ${edit.table} has no name, so the server picked one and ` +
                `this cannot address it. Name your constraints and this becomes reversible.`,
            ],
          };

    case 'drop_constraint': {
      const definition = await constraintOf(adapter, edit.table, edit.name);
      return definition
        ? only(
            `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdentifier(edit.name)} ${definition}`,
          )
        : {
            statements: [],
            gaps: [`Could not read the definition of ${edit.name} before dropping it.`],
          };
    }

    case 'create_table':
      return only(`DROP TABLE IF EXISTS ${table}`);

    case 'drop_table': {
      const recreate = await recreateTable(adapter, edit.table);
      return {
        statements: recreate.statements,
        gaps: [
          `${edit.table} comes back empty${
            recreate.partial ? ', and without everything it had' : ''
          }. Its rows are in the rescue file.`,
          ...recreate.gaps,
        ],
      };
    }

    case 'insert_row':
      // Deleting by the values inserted, which is the only handle there is: the
      // generated key is not known until it exists.
      return {
        statements: [],
        gaps: [
          `A row was inserted into ${edit.table}. Its key was assigned by the server, so ` +
            `this cannot address it — delete it by hand.`,
        ],
      };

    case 'update_row':
    case 'delete_row':
      return {
        statements: [],
        gaps: [
          `${edit.kind === 'delete_row' ? 'A deleted row in' : 'An edited row in'} ` +
            `${edit.table} is restored by the rescue file, not by this.`,
        ],
      };

    default:
      return NOTHING;
  }
}

/**
 * Rebuilds a CREATE TABLE from the catalogue.
 *
 * Deliberately partial and honest about it: columns, primary key and the
 * constraints the catalogue renders back are recreated, and anything else is
 * listed as a gap rather than silently dropped.
 */
async function recreateTable(
  adapter: DatabaseAdapter,
  table: string,
): Promise<{ statements: string[]; gaps: string[]; partial: boolean }> {
  try {
    const detail = await adapter.tableDetail(table, 0);

    const columns = detail.columns.map((column) => {
      const parts = [`  ${quoteIdentifier(column.name)} ${serialType(column)}`];

      if (column.identity) {
        parts.push(
          `GENERATED ${column.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`,
        );
      } else if (column.defaultExpression && !isSequenceDefault(column.defaultExpression)) {
        // A nextval() default is not carried over: `serialType` has already
        // turned the column back into a serial, which recreates the sequence.
        // Copying the default as written would point at a sequence the DROP
        // took with it.
        parts.push(`DEFAULT ${column.defaultExpression}`);
      }

      if (!column.nullable && !column.identity && !isSerial(column)) {
        parts.push('NOT NULL');
      }
      return parts.join(' ');
    });

    if (detail.primaryKey.length > 0) {
      columns.push(`  PRIMARY KEY (${detail.primaryKey.map(quoteIdentifier).join(', ')})`);
    }

    const statements = [
      `CREATE TABLE ${quoteIdentifier(table)} (\n${columns.join(',\n')}\n)`,
    ];

    // Constraints and indexes come after the table exists, and the primary key
    // is already in the definition above.
    for (const constraint of detail.constraints) {
      if (constraint.type === 'primary key') {
        continue;
      }
      statements.push(
        `ALTER TABLE ${quoteIdentifier(table)} ADD CONSTRAINT ` +
          `${quoteIdentifier(constraint.name)} ${constraint.definition}`,
      );
    }

    for (const index of detail.indexes) {
      if (index.primary || index.unique) {
        continue; // carried by the constraints above
      }
      statements.push(index.definition);
    }

    return {
      statements,
      gaps: [
        `The recreated ${table} carries its columns, keys, constraints and indexes. ` +
          `Triggers, rules, comments, grants and ownership are not included.`,
      ],
      partial: true,
    };
  } catch (error) {
    return {
      statements: [],
      gaps: [
        `Could not read ${table} to rebuild it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      partial: true,
    };
  }
}

/**
 * A sequence-backed column, written the way it was declared.
 *
 * `id serial PRIMARY KEY` is stored as an integer with a `nextval` default and
 * an owned sequence. Dropping the table drops the sequence too, so recreating
 * the column with that default produces a table whose first insert fails on a
 * relation that no longer exists. Writing `serial` recreates both.
 */
function serialType(column: {
  type: string;
  defaultExpression?: string;
  identity?: string;
}): string {
  if (!column.defaultExpression || !isSequenceDefault(column.defaultExpression)) {
    return column.type;
  }
  switch (column.type) {
    case 'smallint':
      return 'smallserial';
    case 'integer':
      return 'serial';
    case 'bigint':
      return 'bigserial';
    default:
      return column.type;
  }
}

function isSerial(column: { type: string; defaultExpression?: string }): boolean {
  return serialType(column) !== column.type;
}

function isSequenceDefault(expression: string): boolean {
  return /^nextval\(/i.test(expression.trim());
}

async function columnOf(
  adapter: DatabaseAdapter,
  table: string,
  column: string,
): Promise<
  | {
      name: string;
      type: string;
      nullable: boolean;
      defaultExpression?: string;
      identity?: 'always' | 'by default';
    }
  | undefined
> {
  try {
    return (await adapter.tableColumns(table)).find((found) => found.name === column);
  } catch {
    return undefined;
  }
}

async function constraintOf(
  adapter: DatabaseAdapter,
  table: string,
  name: string,
): Promise<string | undefined> {
  try {
    const detail = await adapter.tableDetail(table, 0);
    return detail.constraints.find((constraint) => constraint.name === name)?.definition;
  } catch {
    return undefined;
  }
}

/** Postgres's own naming, so a DROP IF EXISTS has something to aim at. */
function defaultIndexName(table: string, columns: readonly string[]): string {
  return `${bareName(table)}_${columns.join('_')}_idx`;
}

function defaultConstraintName(
  table: string,
  columns: readonly string[],
  suffix: string,
): string {
  return `${bareName(table)}_${columns.join('_')}_${suffix}`;
}

function bareName(table: string): string {
  return table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
}

function bare(table: string): string {
  return quoteIdentifier(bareName(table));
}

/**
 * Whether going from `from` to `to` loses room.
 *
 * Only the obvious cases, because getting this wrong in the cautious direction
 * costs a sentence and getting it wrong the other way costs data.
 */
function narrowing(from: string, to: string): boolean {
  const size = (type: string): number | undefined => {
    const match = /\((\d+)/.exec(type);
    return match ? Number(match[1]) : undefined;
  };
  const a = size(from);
  const b = size(to);
  if (a !== undefined && b !== undefined) {
    return b > a;
  }
  return /text|varchar|numeric|bigint|double/i.test(to) && !/text|varchar/i.test(from);
}

function only(statement: string): Reversal {
  return { statements: [statement], gaps: [] };
}

function render(statements: readonly string[], gaps: readonly string[]): string {
  const lines = [
    '-- Down migration, generated by Dry Run against the live schema before the',
    '-- change was applied — so the types and defaults below are the real ones,',
    '-- not the ones a migration file remembers.',
    '',
  ];

  if (gaps.length > 0) {
    lines.push('-- What this does NOT undo:');
    for (const gap of gaps) {
      lines.push(`--   * ${gap}`);
    }
    lines.push('');
  }

  if (statements.length === 0) {
    lines.push('-- Nothing here is reversible by DDL alone. See the notes above.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(...statements.map((statement) => `${statement};`), '');
  return lines.join('\n');
}
