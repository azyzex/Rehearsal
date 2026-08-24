import {
  ColumnInfo,
  ForeignKeyInfo,
  SchemaSnapshot,
  SchemaTable,
} from '../adapters/types';
import { Edit, isDataEdit } from './changeset';

/**
 * What the schema will look like afterwards.
 *
 * A pure function from (current schema, pending edits) to the projected schema.
 * The before/after view is then just two snapshots rendered the same way, which
 * means the "after" picture is drawn by exactly the same code as the "before"
 * one and cannot drift from it.
 *
 * This is a projection, not a promise. It says what the edits are *asking* for.
 * Whether they will succeed is a different question, and the one the preview
 * answers by really executing them — a `SET NOT NULL` projects cleanly here and
 * still fails against twelve null rows. The two views answer different halves
 * and the UI shows both.
 */

export interface ColumnChange {
  readonly table: string;
  readonly column: string;
  readonly change: 'added' | 'removed' | 'renamed' | 'retyped' | 'nullability';
  readonly before?: ColumnInfo;
  readonly after?: ColumnInfo;
  readonly note: string;
}

export interface TableChange {
  readonly table: string;
  readonly change: 'added' | 'removed' | 'renamed' | 'altered';
  readonly note: string;
}

export interface SchemaDiff {
  readonly tables: readonly TableChange[];
  readonly columns: readonly ColumnChange[];
  readonly relationships: readonly { readonly change: 'added' | 'removed'; readonly note: string }[];
  /** Edits that change rows rather than structure; the schema picture is unmoved. */
  readonly dataEdits: number;
}

export function projectSchema(before: SchemaSnapshot, edits: readonly Edit[]): SchemaSnapshot {
  let tables = before.tables.map(cloneTable);
  let foreignKeys = [...before.foreignKeys];

  const findTable = (name: string): SchemaTable | undefined =>
    tables.find((table) => table.qualified === name || table.name === name);

  for (const edit of edits) {
    if (isDataEdit(edit)) {
      continue; // rows change, structure does not
    }

    const table = findTable(edit.table);

    switch (edit.kind) {
      case 'add_column': {
        if (!table) break;
        replace(tables, table, {
          ...table,
          columns: [
            ...table.columns,
            {
              name: edit.column,
              type: edit.type,
              nullable: edit.nullable,
              isPrimaryKey: false,
            },
          ],
        });
        break;
      }

      case 'drop_column': {
        if (!table) break;
        replace(tables, table, {
          ...table,
          columns: table.columns.filter((column) => column.name !== edit.column),
        });
        // A relationship whose column is gone cannot survive it.
        foreignKeys = foreignKeys.filter(
          (fk) =>
            !(fk.fromTable === table.qualified && fk.fromColumns.includes(edit.column)) &&
            !(fk.toTable === table.qualified && fk.toColumns.includes(edit.column)),
        );
        break;
      }

      case 'rename_column': {
        if (!table) break;
        replace(tables, table, {
          ...table,
          columns: table.columns.map((column) =>
            column.name === edit.column ? { ...column, name: edit.to } : column,
          ),
        });
        foreignKeys = foreignKeys.map((fk) => ({
          ...fk,
          fromColumns:
            fk.fromTable === table.qualified
              ? fk.fromColumns.map((c) => (c === edit.column ? edit.to : c))
              : fk.fromColumns,
          toColumns:
            fk.toTable === table.qualified
              ? fk.toColumns.map((c) => (c === edit.column ? edit.to : c))
              : fk.toColumns,
        }));
        break;
      }

      case 'alter_type': {
        if (!table) break;
        replace(tables, table, {
          ...table,
          columns: table.columns.map((column) =>
            column.name === edit.column ? { ...column, type: edit.to } : column,
          ),
        });
        break;
      }

      case 'set_nullability': {
        if (!table) break;
        replace(tables, table, {
          ...table,
          columns: table.columns.map((column) =>
            column.name === edit.column ? { ...column, nullable: edit.nullable } : column,
          ),
        });
        break;
      }

      case 'add_foreign_key': {
        if (!table) break;
        foreignKeys = [
          ...foreignKeys,
          {
            name: edit.name ?? `${table.name}_${edit.columns.join('_')}_fkey`,
            fromTable: table.qualified,
            fromColumns: [...edit.columns],
            toTable: edit.referencedTable,
            toColumns: [...edit.referencedColumns],
          },
        ];
        break;
      }

      case 'drop_constraint': {
        foreignKeys = foreignKeys.filter((fk) => fk.name !== edit.name);
        break;
      }

      case 'rename_table': {
        if (!table) break;
        const renamed: SchemaTable = {
          ...table,
          name: edit.to,
          qualified: table.schema === 'public' ? edit.to : `${table.schema}.${edit.to}`,
        };
        replace(tables, table, renamed);
        foreignKeys = foreignKeys.map((fk) => ({
          ...fk,
          fromTable: fk.fromTable === table.qualified ? renamed.qualified : fk.fromTable,
          toTable: fk.toTable === table.qualified ? renamed.qualified : fk.toTable,
        }));
        break;
      }

      case 'create_table': {
        if (table) {
          break; // already there; the preview will report the real conflict
        }
        const [schema, name] = edit.table.includes('.')
          ? (edit.table.split('.') as [string, string])
          : (['public', edit.table] as [string, string]);

        tables = [
          ...tables,
          {
            schema,
            name,
            qualified: edit.table,
            rows: 0,
            bytes: 0,
            partitioned: false,
            columns: edit.columns.map((column) => ({
              name: column.name,
              type: column.type,
              nullable: column.nullable,
              isPrimaryKey: column.primaryKey === true,
            })),
          },
        ];
        break;
      }

      case 'drop_table': {
        if (!table) break;
        tables = tables.filter((candidate) => candidate.qualified !== table.qualified);
        foreignKeys = foreignKeys.filter(
          (fk) => fk.fromTable !== table.qualified && fk.toTable !== table.qualified,
        );
        break;
      }

      // Indexes, unique constraints and checks do not change the shape the
      // diagram draws, so the projection leaves the picture alone. Their real
      // consequences are what the preview measures.
      default:
        break;
    }
  }

  return { tables, foreignKeys, schemas: before.schemas };
}

/** What changed between two snapshots, for the before/after summary. */
export function diffSchemas(
  before: SchemaSnapshot,
  after: SchemaSnapshot,
  edits: readonly Edit[],
): SchemaDiff {
  const tableChanges: TableChange[] = [];
  const columnChanges: ColumnChange[] = [];
  const relationshipChanges: { change: 'added' | 'removed'; note: string }[] = [];

  const beforeTables = new Map(before.tables.map((t) => [t.qualified, t]));
  const afterTables = new Map(after.tables.map((t) => [t.qualified, t]));

  for (const [name, table] of afterTables) {
    if (!beforeTables.has(name)) {
      tableChanges.push({ table: name, change: 'added', note: `${name} is created` });
    } else {
      const changes = diffColumns(name, beforeTables.get(name)!, table);
      columnChanges.push(...changes);
      if (changes.length > 0) {
        tableChanges.push({
          table: name,
          change: 'altered',
          note: `${changes.length} ${changes.length === 1 ? 'column changes' : 'columns change'}`,
        });
      }
    }
  }

  for (const [name, table] of beforeTables) {
    if (!afterTables.has(name)) {
      tableChanges.push({
        table: name,
        change: 'removed',
        note: `${name} is dropped, with all ${table.rows.toLocaleString()} rows`,
      });
    }
  }

  const key = (fk: ForeignKeyInfo): string =>
    `${fk.fromTable}(${fk.fromColumns.join(',')})->${fk.toTable}(${fk.toColumns.join(',')})`;
  const beforeKeys = new Set(before.foreignKeys.map(key));
  const afterKeys = new Set(after.foreignKeys.map(key));

  for (const fk of after.foreignKeys) {
    if (!beforeKeys.has(key(fk))) {
      relationshipChanges.push({
        change: 'added',
        note: `${fk.fromTable}.${fk.fromColumns.join(', ')} now points at ${fk.toTable}`,
      });
    }
  }
  for (const fk of before.foreignKeys) {
    if (!afterKeys.has(key(fk))) {
      relationshipChanges.push({
        change: 'removed',
        note: `${fk.fromTable}.${fk.fromColumns.join(', ')} no longer points at ${fk.toTable}`,
      });
    }
  }

  return {
    tables: tableChanges,
    columns: columnChanges,
    relationships: relationshipChanges,
    dataEdits: edits.filter(isDataEdit).length,
  };
}

function diffColumns(table: string, before: SchemaTable, after: SchemaTable): ColumnChange[] {
  const changes: ColumnChange[] = [];
  const beforeColumns = new Map(before.columns.map((c) => [c.name, c]));
  const afterColumns = new Map(after.columns.map((c) => [c.name, c]));

  for (const [name, column] of afterColumns) {
    const previous = beforeColumns.get(name);
    if (!previous) {
      changes.push({
        table,
        column: name,
        change: 'added',
        after: column,
        note: `${name} is added as ${column.type}${column.nullable ? '' : ', not null'}`,
      });
      continue;
    }
    if (previous.type !== column.type) {
      changes.push({
        table,
        column: name,
        change: 'retyped',
        before: previous,
        after: column,
        note: `${name} changes from ${previous.type} to ${column.type}`,
      });
    }
    if (previous.nullable !== column.nullable) {
      changes.push({
        table,
        column: name,
        change: 'nullability',
        before: previous,
        after: column,
        note: column.nullable
          ? `${name} starts allowing nulls`
          : `${name} stops allowing nulls`,
      });
    }
  }

  for (const [name, column] of beforeColumns) {
    if (!afterColumns.has(name)) {
      changes.push({
        table,
        column: name,
        change: 'removed',
        before: column,
        note: `${name} is dropped`,
      });
    }
  }

  return changes;
}

function cloneTable(table: SchemaTable): SchemaTable {
  return { ...table, columns: table.columns.map((column) => ({ ...column })) };
}

function replace(tables: SchemaTable[], previous: SchemaTable, next: SchemaTable): void {
  const index = tables.indexOf(previous);
  if (index !== -1) {
    tables[index] = next;
  }
}
