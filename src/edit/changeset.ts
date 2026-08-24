/**
 * Pending edits, and the SQL they become.
 *
 * The visual editor never talks to the database. It builds a changeset — an
 * ordered list of intended edits — and this module turns that into statements.
 * Those statements then go through exactly the same preview pipeline as a
 * hand-written migration file: really executed, measured, rolled back.
 *
 * That indirection is the whole design. Clicking "drop column" in a diagram is
 * an enormously easier action than typing `ALTER TABLE users DROP COLUMN
 * phone_number`, and making a destructive act easier without making its
 * consequences more visible is how you build a footgun. So the edit produces
 * SQL you can read, the SQL produces a measurement you can check, and only then
 * is there anything to apply.
 *
 * Values travel as bound parameters rather than being interpolated. Generating
 * SQL by pasting user data into a string is the oldest mistake in the field,
 * and a visual editor is exactly where untrusted-looking values arrive.
 */

export type SchemaEditKind =
  | 'add_column'
  | 'drop_column'
  | 'rename_column'
  | 'alter_type'
  | 'set_nullability'
  | 'set_default'
  | 'add_index'
  | 'add_unique'
  | 'add_foreign_key'
  | 'add_check'
  | 'drop_constraint'
  | 'rename_table'
  | 'drop_table';

export type DataEditKind = 'update_row' | 'delete_row' | 'insert_row';

export interface AddColumn {
  readonly kind: 'add_column';
  readonly table: string;
  readonly column: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultExpression?: string;
}

export interface DropColumn {
  readonly kind: 'drop_column';
  readonly table: string;
  readonly column: string;
}

export interface RenameColumn {
  readonly kind: 'rename_column';
  readonly table: string;
  readonly column: string;
  readonly to: string;
}

export interface AlterType {
  readonly kind: 'alter_type';
  readonly table: string;
  readonly column: string;
  readonly to: string;
  readonly using?: string;
}

export interface SetNullability {
  readonly kind: 'set_nullability';
  readonly table: string;
  readonly column: string;
  readonly nullable: boolean;
}

export interface SetDefault {
  readonly kind: 'set_default';
  readonly table: string;
  readonly column: string;
  /** Absent drops the default. */
  readonly expression?: string;
}

export interface AddIndex {
  readonly kind: 'add_index';
  readonly table: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly concurrently: boolean;
  readonly name?: string;
}

export interface AddUnique {
  readonly kind: 'add_unique';
  readonly table: string;
  readonly columns: readonly string[];
  readonly name?: string;
}

export interface AddForeignKey {
  readonly kind: 'add_foreign_key';
  readonly table: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly name?: string;
}

export interface AddCheck {
  readonly kind: 'add_check';
  readonly table: string;
  readonly expression: string;
  readonly name?: string;
}

export interface DropConstraint {
  readonly kind: 'drop_constraint';
  readonly table: string;
  readonly name: string;
}

export interface RenameTable {
  readonly kind: 'rename_table';
  readonly table: string;
  readonly to: string;
}

export interface DropTable {
  readonly kind: 'drop_table';
  readonly table: string;
}

export interface UpdateRow {
  readonly kind: 'update_row';
  readonly table: string;
  /** Primary key of the row being edited. */
  readonly key: Readonly<Record<string, unknown>>;
  readonly set: Readonly<Record<string, unknown>>;
}

export interface DeleteRow {
  readonly kind: 'delete_row';
  readonly table: string;
  readonly key: Readonly<Record<string, unknown>>;
}

export interface InsertRow {
  readonly kind: 'insert_row';
  readonly table: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export type SchemaEdit =
  | AddColumn
  | DropColumn
  | RenameColumn
  | AlterType
  | SetNullability
  | SetDefault
  | AddIndex
  | AddUnique
  | AddForeignKey
  | AddCheck
  | DropConstraint
  | RenameTable
  | DropTable;

export type DataEdit = UpdateRow | DeleteRow | InsertRow;
export type Edit = SchemaEdit | DataEdit;

export interface GeneratedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Plain-English label for the edit that produced it. */
  readonly label: string;
  /** Index of the edit in the changeset, so the UI can pair them up. */
  readonly editIndex: number;
}

const DATA_KINDS: ReadonlySet<string> = new Set(['update_row', 'delete_row', 'insert_row']);

export function isDataEdit(edit: Edit): edit is DataEdit {
  return DATA_KINDS.has(edit.kind);
}

/**
 * Quotes an identifier, which may be schema-qualified.
 *
 * Identifiers cannot be bound as parameters, so this is the one place where
 * caller-supplied text reaches the SQL directly. It rejects anything it cannot
 * quote safely rather than trying to sanitise it — a table name containing a
 * null byte is not a typo to be cleaned up, it is someone probing.
 */
export function quoteIdentifier(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('An identifier cannot be empty.');
  }
  if (trimmed.includes('\0')) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${trimmed.replace(/"/g, '""')}"`;
}

export function quoteQualified(table: string): string {
  return table
    .split('.')
    .map((part) => quoteIdentifier(part))
    .join('.');
}

/**
 * Types and expressions cannot be parameters either. Rather than attempt to
 * parse them, they are restricted to the characters a type or a simple
 * expression actually needs, which excludes the ones that end a statement and
 * start another.
 */
export function checkTypeName(type: string): string {
  const trimmed = type.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*(\([\d, ]*\))?(\[\])*$/.test(trimmed)) {
    throw new Error(`Unsupported type: ${JSON.stringify(type)}`);
  }
  return trimmed;
}

export function checkExpression(expression: string): string {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new Error('An expression cannot be empty.');
  }
  if (trimmed.includes(';') || trimmed.includes('--') || trimmed.includes('/*')) {
    throw new Error(
      `Expressions may not contain statement terminators or comments: ${JSON.stringify(expression)}`,
    );
  }
  return trimmed;
}

/** A human-readable summary, used as the label on the pending-change list. */
export function describeEdit(edit: Edit): string {
  switch (edit.kind) {
    case 'add_column':
      return `Add ${edit.table}.${edit.column} (${edit.type}${edit.nullable ? '' : ', not null'})`;
    case 'drop_column':
      return `Drop ${edit.table}.${edit.column}`;
    case 'rename_column':
      return `Rename ${edit.table}.${edit.column} to ${edit.to}`;
    case 'alter_type':
      return `Change ${edit.table}.${edit.column} to ${edit.to}`;
    case 'set_nullability':
      return `${edit.nullable ? 'Allow' : 'Forbid'} nulls in ${edit.table}.${edit.column}`;
    case 'set_default':
      return edit.expression
        ? `Default ${edit.table}.${edit.column} to ${edit.expression}`
        : `Remove the default on ${edit.table}.${edit.column}`;
    case 'add_index':
      return `Index ${edit.table} (${edit.columns.join(', ')})${edit.concurrently ? ' concurrently' : ''}`;
    case 'add_unique':
      return `Require ${edit.table} (${edit.columns.join(', ')}) to be unique`;
    case 'add_foreign_key':
      return `Link ${edit.table} (${edit.columns.join(', ')}) to ${edit.referencedTable}`;
    case 'add_check':
      return `Require ${edit.expression} on ${edit.table}`;
    case 'drop_constraint':
      return `Drop constraint ${edit.name} on ${edit.table}`;
    case 'rename_table':
      return `Rename ${edit.table} to ${edit.to}`;
    case 'drop_table':
      return `Drop the table ${edit.table}`;
    case 'update_row':
      return `Update one row in ${edit.table} (${describeKey(edit.key)})`;
    case 'delete_row':
      return `Delete one row from ${edit.table} (${describeKey(edit.key)})`;
    case 'insert_row':
      return `Insert a row into ${edit.table}`;
    default:
      return 'Unknown change';
  }
}

function describeKey(key: Readonly<Record<string, unknown>>): string {
  return Object.entries(key)
    .map(([column, value]) => `${column} = ${String(value)}`)
    .join(', ');
}

/** Turns one edit into the statement that performs it. */
export function toStatement(edit: Edit, editIndex: number): GeneratedStatement {
  const label = describeEdit(edit);
  const make = (sql: string, params: readonly unknown[] = []): GeneratedStatement => ({
    sql,
    params,
    label,
    editIndex,
  });

  switch (edit.kind) {
    case 'add_column': {
      const parts = [
        `ALTER TABLE ${quoteQualified(edit.table)} ADD COLUMN ${quoteIdentifier(edit.column)} ${checkTypeName(edit.type)}`,
      ];
      if (edit.defaultExpression) {
        parts.push(`DEFAULT ${checkExpression(edit.defaultExpression)}`);
      }
      if (!edit.nullable) {
        parts.push('NOT NULL');
      }
      return make(parts.join(' '));
    }

    case 'drop_column':
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} DROP COLUMN ${quoteIdentifier(edit.column)}`,
      );

    case 'rename_column':
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} RENAME COLUMN ${quoteIdentifier(edit.column)} TO ${quoteIdentifier(edit.to)}`,
      );

    case 'alter_type': {
      const base = `ALTER TABLE ${quoteQualified(edit.table)} ALTER COLUMN ${quoteIdentifier(edit.column)} TYPE ${checkTypeName(edit.to)}`;
      return make(edit.using ? `${base} USING ${checkExpression(edit.using)}` : base);
    }

    case 'set_nullability':
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} ALTER COLUMN ${quoteIdentifier(edit.column)} ${edit.nullable ? 'DROP' : 'SET'} NOT NULL`,
      );

    case 'set_default':
      return make(
        edit.expression
          ? `ALTER TABLE ${quoteQualified(edit.table)} ALTER COLUMN ${quoteIdentifier(edit.column)} SET DEFAULT ${checkExpression(edit.expression)}`
          : `ALTER TABLE ${quoteQualified(edit.table)} ALTER COLUMN ${quoteIdentifier(edit.column)} DROP DEFAULT`,
      );

    case 'add_index': {
      const name = edit.name ?? defaultIndexName(edit.table, edit.columns, edit.unique);
      return make(
        `CREATE ${edit.unique ? 'UNIQUE ' : ''}INDEX ${edit.concurrently ? 'CONCURRENTLY ' : ''}` +
          `${quoteIdentifier(name)} ON ${quoteQualified(edit.table)} ` +
          `(${edit.columns.map(quoteIdentifier).join(', ')})`,
      );
    }

    case 'add_unique': {
      const name = edit.name ?? `${bare(edit.table)}_${edit.columns.join('_')}_key`;
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} ADD CONSTRAINT ${quoteIdentifier(name)} ` +
          `UNIQUE (${edit.columns.map(quoteIdentifier).join(', ')})`,
      );
    }

    case 'add_foreign_key': {
      const name = edit.name ?? `${bare(edit.table)}_${edit.columns.join('_')}_fkey`;
      const target =
        edit.referencedColumns.length > 0
          ? ` (${edit.referencedColumns.map(quoteIdentifier).join(', ')})`
          : '';
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} ADD CONSTRAINT ${quoteIdentifier(name)} ` +
          `FOREIGN KEY (${edit.columns.map(quoteIdentifier).join(', ')}) ` +
          `REFERENCES ${quoteQualified(edit.referencedTable)}${target}`,
      );
    }

    case 'add_check': {
      const name = edit.name ?? `${bare(edit.table)}_check`;
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} ADD CONSTRAINT ${quoteIdentifier(name)} ` +
          `CHECK (${checkExpression(edit.expression)})`,
      );
    }

    case 'drop_constraint':
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} DROP CONSTRAINT ${quoteIdentifier(edit.name)}`,
      );

    case 'rename_table':
      return make(
        `ALTER TABLE ${quoteQualified(edit.table)} RENAME TO ${quoteIdentifier(edit.to)}`,
      );

    case 'drop_table':
      return make(`DROP TABLE ${quoteQualified(edit.table)}`);

    case 'update_row': {
      const params: unknown[] = [];
      const assignments = Object.entries(edit.set).map(([column, value]) => {
        params.push(value);
        return `${quoteIdentifier(column)} = $${params.length}`;
      });
      if (assignments.length === 0) {
        throw new Error('An update needs at least one column to change.');
      }
      const where = keyPredicate(edit.key, params);
      return make(
        `UPDATE ${quoteQualified(edit.table)} SET ${assignments.join(', ')} WHERE ${where}`,
        params,
      );
    }

    case 'delete_row': {
      const params: unknown[] = [];
      const where = keyPredicate(edit.key, params);
      return make(`DELETE FROM ${quoteQualified(edit.table)} WHERE ${where}`, params);
    }

    case 'insert_row': {
      const columns = Object.keys(edit.values);
      if (columns.length === 0) {
        throw new Error('An insert needs at least one value.');
      }
      const params = columns.map((column) => edit.values[column]);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      return make(
        `INSERT INTO ${quoteQualified(edit.table)} ` +
          `(${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders.join(', ')})`,
        params,
      );
    }

    default:
      throw new Error(`Unsupported edit: ${JSON.stringify(edit)}`);
  }
}

/**
 * A WHERE that identifies exactly one row by its primary key.
 *
 * An empty key would produce `WHERE true` and edit the whole table, so it is
 * refused. The visual editor is the one place where a missing WHERE could
 * happen silently rather than being visible in text the user wrote.
 */
function keyPredicate(key: Readonly<Record<string, unknown>>, params: unknown[]): string {
  const entries = Object.entries(key);
  if (entries.length === 0) {
    throw new Error(
      'This row cannot be identified: its table has no primary key, so an edit ' +
        'could not be limited to it.',
    );
  }

  return entries
    .map(([column, value]) => {
      if (value === null || value === undefined) {
        return `${quoteIdentifier(column)} IS NULL`;
      }
      params.push(value);
      return `${quoteIdentifier(column)} = $${params.length}`;
    })
    .join(' AND ');
}

function defaultIndexName(table: string, columns: readonly string[], unique: boolean): string {
  return `${unique ? 'uq' : 'idx'}_${bare(table)}_${columns.join('_')}`;
}

function bare(table: string): string {
  const parts = table.split('.');
  return (parts[parts.length - 1] ?? table).replace(/"/g, '');
}

/**
 * An ordered set of pending edits.
 *
 * Order is preserved and meaningful: dropping a column and then indexing it is
 * a different thing from doing it the other way round, and the preview has to
 * see them in the order they would really run.
 */
export class Changeset {
  private edits: Edit[] = [];

  get size(): number {
    return this.edits.length;
  }

  get isEmpty(): boolean {
    return this.edits.length === 0;
  }

  list(): readonly Edit[] {
    return [...this.edits];
  }

  add(edit: Edit): number {
    this.edits.push(edit);
    return this.edits.length - 1;
  }

  removeAt(index: number): void {
    if (index >= 0 && index < this.edits.length) {
      this.edits.splice(index, 1);
    }
  }

  clear(): void {
    this.edits = [];
  }

  /** Every edit as the statement that performs it, in order. */
  statements(): GeneratedStatement[] {
    return this.edits.map((edit, index) => toStatement(edit, index));
  }

  /** The changeset as a migration file someone could read, review and keep. */
  toSql(): string {
    return this.edits
      .map((edit, index) => {
        const statement = toStatement(edit, index);
        const inlined = inlineParams(statement.sql, statement.params);
        return `-- ${statement.label}\n${inlined};`;
      })
      .join('\n\n');
  }
}

/**
 * Renders parameters into the SQL for *display only*.
 *
 * Never used to execute anything — execution always binds parameters. This
 * exists so the changeset can be shown and exported as a migration file that
 * reads the way a human would have written it.
 */
export function inlineParams(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (whole, digits: string) => {
    const value = params[Number(digits) - 1];
    return value === undefined ? whole : literalForDisplay(value);
  });
}

function literalForDisplay(value: unknown): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}
