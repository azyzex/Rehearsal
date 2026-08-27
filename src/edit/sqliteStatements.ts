import { Edit, GeneratedStatement, quoteIdentifier, quoteQualified, toStatement } from './changeset';

/**
 * The visual editor's changes, in the small part of `ALTER TABLE` SQLite has.
 *
 * SQLite's entire `ALTER TABLE` is four things: `ADD COLUMN`, `DROP COLUMN`,
 * `RENAME TO` and `RENAME COLUMN`. There is no changing a column's type, no
 * making one `NOT NULL`, no adding or dropping a constraint, no adding a
 * foreign key. Those are not missing keywords — the operations do not exist.
 *
 * The documented way to do any of them is to build a replacement table with the
 * shape you want, copy every row into it, drop the original and rename: a
 * twelve-step procedure in a specific order, with foreign key enforcement
 * turned off in the middle of it, and every index and trigger recreated by
 * hand afterwards.
 *
 * So this refuses them, by name, with what it would actually take. That is the
 * same decision the MongoDB writer makes for defaults and nullability, and for
 * the same reason: the alternative is exporting a file that reads like SQL, is
 * offered as the thing to review and keep, and fails on the first line the
 * moment anyone runs it.
 *
 * What it does not do is offer to generate the rebuild. Twelve steps that move
 * every row of a table, generated from a schema read a moment ago, is a much
 * larger promise than anything else here makes — and the one place where being
 * wrong loses the data rather than reporting the wrong number.
 */

const REBUILD =
  'SQLite cannot do this with ALTER TABLE. The documented way is to create a ' +
  'replacement table with the shape you want, copy every row into it, drop the ' +
  'original and rename — with foreign keys disabled while you do it, and every ' +
  'index and trigger recreated afterwards. Dry Run will not generate that for ' +
  'you: it moves every row, and being wrong about it loses the table.';

export function toSqliteStatement(edit: Edit, editIndex: number): GeneratedStatement {
  switch (edit.kind) {
    case 'alter_type':
      throw new Error(
        `SQLite has no ALTER COLUMN, so ${edit.table}.${edit.column} cannot be retyped ` +
          `in place. ${REBUILD}`,
      );

    case 'set_nullability':
      throw new Error(
        `SQLite cannot add or remove NOT NULL on an existing column ` +
          `(${edit.table}.${edit.column}). ${REBUILD}`,
      );

    case 'set_default':
      throw new Error(
        `SQLite cannot change a column's default after the table is created ` +
          `(${edit.table}.${edit.column}). ${REBUILD}`,
      );

    case 'add_unique':
      // The constraint cannot be added, but the thing it is for can: a unique
      // index enforces exactly the same rule and SQLite creates one happily.
      return {
        sql:
          `CREATE UNIQUE INDEX ${quoteIdentifier(
            edit.name ?? `uq_${bare(edit.table)}_${edit.columns.join('_')}`,
          )} ON ${quoteQualified(edit.table)} ` +
          `(${edit.columns.map(quoteIdentifier).join(', ')})`,
        params: [],
        label: `Unique index on ${edit.table} (${edit.columns.join(', ')})`,
        editIndex,
      };

    case 'add_foreign_key':
      throw new Error(
        `SQLite cannot add a foreign key to an existing table. ${REBUILD} ` +
          `It is also worth checking PRAGMA foreign_keys first: it is off by ` +
          `default, and a key that is not enforced is not a constraint.`,
      );

    case 'add_check':
      throw new Error(`SQLite cannot add a CHECK constraint to an existing table. ${REBUILD}`);

    case 'drop_constraint':
      throw new Error(`SQLite cannot drop a constraint. ${REBUILD}`);

    case 'add_index':
      // CONCURRENTLY is a Postgres keyword and a syntax error here. There is
      // nothing to lose by dropping it: SQLite has no online build to ask for.
      return toStatement({ ...edit, concurrently: false }, editIndex);

    default:
      // Everything else is ordinary SQL that SQLite speaks: ADD COLUMN, DROP
      // COLUMN, both renames, CREATE TABLE, CREATE INDEX, and the row edits.
      return toStatement(edit, editIndex);
  }
}

function bare(table: string): string {
  const parts = table.split('.');
  return (parts[parts.length - 1] ?? table).replace(/"/g, '');
}
