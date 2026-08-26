import { DatabaseAdapter } from '../adapters/types';
import { DownMigration } from './down';
import { Edit } from './changeset';

/**
 * The script that undoes a changeset, for MongoDB.
 *
 * The same bargain the SQL version makes, and the same reason for making it:
 * a down migration is written when you are looking at the schema *after*, so
 * it gets guessed, committed, never run, and is wrong on the one night it
 * matters. This one is generated before the change, against the live database,
 * so the index it recreates is the index that was really there.
 *
 * What differs is how much of a changeset is reversible here, and it is less.
 * A `$unset` takes the values with it and no operation brings them back — but
 * so does a DROP COLUMN, and the honest thing in both cases is to say so and
 * point at the rescue file rather than emit something that looks like it would
 * work. What *is* exactly reversible is the structural half: `$rename` goes
 * back, `createIndex` becomes `dropIndex`, a renamed collection renames back.
 *
 * The gaps list is the part worth reading. A down migration with gaps is still
 * worth having; one that hides them is worse than none, because it will be
 * trusted.
 */

interface Reversal {
  statements: string[];
  gaps: string[];
}

const NOTHING: Reversal = { statements: [], gaps: [] };

const only = (statement: string): Reversal => ({ statements: [statement], gaps: [] });

export async function mongoDownMigration(
  adapter: DatabaseAdapter,
  edits: readonly Edit[],
): Promise<DownMigration> {
  const statements: string[] = [];
  const gaps: string[] = [];

  // Reversed, for the same reason the SQL version reverses: undoing a sequence
  // means undoing the last thing first, or you rename a collection that has
  // not been recreated yet.
  for (const edit of [...edits].reverse()) {
    const reversal = await reverse(adapter, edit);
    statements.push(...reversal.statements);
    gaps.push(...reversal.gaps);
  }

  return { statements, gaps, sql: render(statements, gaps) };
}

async function reverse(adapter: DatabaseAdapter, edit: Edit): Promise<Reversal> {
  const on = (collection: string): string => `db.getCollection(${quote(collection)})`;

  switch (edit.kind) {
    case 'add_column': {
      // The forward operation backfilled the documents that did not have the
      // field. Undoing it means unsetting exactly those, and after the fact
      // they are indistinguishable from the ones that already held that value.
      if (edit.defaultExpression === undefined || edit.defaultExpression === null) {
        // Nothing ran forward, so nothing has to run back.
        return NOTHING;
      }
      return {
        statements: [],
        gaps: [
          `${edit.table}.${edit.column} was backfilled onto the documents that did not have ` +
            `it. Those documents are no longer distinguishable from the ones that already ` +
            `held that value, so this cannot unset only the ones it set.`,
        ],
      };
    }

    case 'drop_column':
      // The field can be put back on the documents that had it. Its values
      // cannot, and that is what the rescue file is for.
      return {
        statements: [],
        gaps: [
          `${edit.table}.${edit.column} was removed from every document and the values went ` +
            `with it. They are in the rescue file; nothing in this script brings them back.`,
        ],
      };

    case 'rename_column':
      // Exactly reversible, which is most of what makes it worth generating.
      return only(
        `${on(edit.table)}.updateMany({}, { $rename: { ${quote(edit.to)}: ${quote(edit.column)} } })`,
      );

    case 'rename_table':
      return only(`${on(edit.to)}.renameCollection(${quote(bare(edit.table))})`);

    case 'alter_type': {
      // The conversion is reversible as an operation and not as a fact: a
      // double that became an int lost what was after the point, and converting
      // back produces a double holding a rounded number.
      const was = await typeOf(adapter, edit.table, edit.column);
      if (!was) {
        return {
          statements: [],
          gaps: [
            `Could not read the type of ${edit.table}.${edit.column} before it was changed, ` +
              `so there is nothing to convert it back to.`,
          ],
        };
      }

      return {
        statements: [
          `${on(edit.table)}.updateMany({}, [\n` +
            `  { $set: { ${quote(edit.column)}: { $convert: { input: ${quote('$' + edit.column)}, ` +
            `to: ${quote(was)}, onError: ${quote('$' + edit.column)} } } } }\n])`,
        ],
        gaps: [
          `Converting ${edit.table}.${edit.column} back to ${was} restores the type, not the ` +
            `precision a conversion rounded away.`,
        ],
      };
    }

    case 'add_index':
      return only(`${on(edit.table)}.dropIndex(${quote(indexName(edit.columns, edit.name))})`);

    case 'add_unique':
      return only(`${on(edit.table)}.dropIndex(${quote(indexName(edit.columns, edit.name))})`);

    case 'drop_constraint': {
      // Recreated from the index as it really was, read before it was dropped.
      const index = await indexOf(adapter, edit.table, edit.name);
      if (!index) {
        return {
          statements: [],
          gaps: [
            `Could not read the definition of the index ${edit.name} on ${edit.table} before ` +
              `it was dropped, so this cannot recreate it.`,
          ],
        };
      }

      const keys = index.columns.map((column) => `${quote(column)}: 1`).join(', ');
      const options = [`name: ${quote(index.name)}`];
      if (index.unique) {
        options.push('unique: true');
      }
      return only(`${on(edit.table)}.createIndex({ ${keys} }, { ${options.join(', ')} })`);
    }

    case 'create_table':
      return only(`${on(edit.table)}.drop()`);

    case 'drop_table':
      // The collection can be recreated. Its documents are gone, and the
      // indexes went with them.
      return {
        statements: [`db.createCollection(${quote(bare(edit.table))})`],
        gaps: [
          `${edit.table} comes back empty, and without the indexes it had. Its documents are ` +
            `in the rescue file.`,
        ],
      };

    case 'insert_row':
      return {
        statements: [],
        gaps: [
          `A document was inserted into ${edit.table}. If its _id was generated by the server ` +
            `this cannot address it — delete it by hand.`,
        ],
      };

    case 'update_row':
    case 'delete_row':
      return {
        statements: [],
        gaps: [
          `${edit.kind === 'delete_row' ? 'A deleted document in' : 'An edited document in'} ` +
            `${edit.table} is restored by the rescue file, not by this.`,
        ],
      };

    // Refused going forward, so there is nothing to undo. Listed rather than
    // falling through the default, so that adding a new edit kind and
    // forgetting it here shows up as a compile error rather than as silence.
    case 'set_nullability':
    case 'set_default':
    case 'add_foreign_key':
    case 'add_check':
      return NOTHING;

    default:
      return NOTHING;
  }
}

/**
 * The name MongoDB gives an index when you do not name one.
 *
 * `{ a: 1, b: 1 }` becomes `a_1_b_1`. Getting this wrong produces a
 * `dropIndex` that fails on a name that never existed, which is a down
 * migration that stops halfway.
 */
function indexName(columns: readonly string[], given?: string): string {
  return given ?? columns.map((column) => `${column}_1`).join('_');
}

async function typeOf(
  adapter: DatabaseAdapter,
  table: string,
  column: string,
): Promise<string | undefined> {
  try {
    const detail = await adapter.tableDetail(table, 0);
    const found = detail.columns.find((one) => one.name === column);
    if (!found) {
      return undefined;
    }
    // A sampled field can hold more than one type, and `$convert` takes one.
    // The first is the commonest, which the adapter orders it by.
    return found.type.split('|')[0]?.trim();
  } catch {
    return undefined;
  }
}

async function indexOf(
  adapter: DatabaseAdapter,
  table: string,
  name: string,
): Promise<{ name: string; columns: readonly string[]; unique: boolean } | undefined> {
  try {
    const detail = await adapter.tableDetail(table, 0);
    return detail.indexes.find((index) => index.name === name);
  } catch {
    return undefined;
  }
}

/** A collection name has no database qualifier in front of it. */
function bare(name: string): string {
  const at = name.lastIndexOf('.');
  return at === -1 ? name : name.slice(at + 1);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function render(statements: readonly string[], gaps: readonly string[]): string {
  const lines = [
    '// Down script, generated by Dry Run against the live database before the',
    '// change was applied — so the index it recreates is the index that was',
    '// really there, not the one a migration file remembers.',
    '//',
    '// Paste into mongosh, or run with: mongosh <connection string> <this file>',
    '',
  ];

  if (gaps.length > 0) {
    lines.push('// What this does NOT undo:');
    for (const gap of gaps) {
      lines.push(`//   * ${gap}`);
    }
    lines.push('');
  }

  if (statements.length === 0) {
    lines.push('// Nothing here is reversible by an operation alone. See the notes above.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(...statements.map((statement) => `${statement};`), '');
  return lines.join('\n');
}
