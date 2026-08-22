import { ColumnInfo, DatabaseAdapter } from '../adapters/types';
import { Finding, Severity } from './types';
import { worst } from './severity';

/**
 * The impact diagram.
 *
 * A schema diagram shows you what the database looks like. There are a dozen
 * extensions that do that, and they all show you the same picture whatever you
 * are about to run. This shows something different: the tables *this migration
 * touches*, drawn with what the migration does to them — the column being
 * dropped struck through with the number of rows that lose data, the foreign
 * key that will fail drawn as a broken arrow with its orphan count, the table
 * that will be locked marked as locked.
 *
 * Same visual language as an ERD, opposite content. An ERD is a map; this is a
 * weather forecast for one journey across it.
 *
 * Everything here is derived from findings that have already been measured.
 * The only extra work is reading the column lists and existing foreign keys of
 * the touched tables, so the diagram can draw the parts the migration does not
 * touch as context around the parts it does.
 */

export type ColumnImpact =
  | 'drop'
  | 'add'
  | 'not_null'
  | 'type'
  | 'unique'
  | 'foreign_key'
  | 'index'
  | 'rename'
  | 'written';

export interface DiagramColumn {
  readonly name: string;
  readonly type: string;
  readonly isPrimaryKey: boolean;
  readonly nullable: boolean;
  /** Absent when the migration does not touch this column. */
  readonly impact?: ColumnImpact;
  readonly severity?: Severity;
  /** Short label drawn against the column: "40,072 rows lost". */
  readonly note?: string;
  /** Which statement caused it, so clicking jumps to the line. */
  readonly statementIndex?: number;
}

export interface DiagramTable {
  readonly name: string;
  readonly rows?: number;
  /** Worst severity of anything happening to this table. */
  readonly severity: Severity;
  readonly columns: readonly DiagramColumn[];
  /** Table-level events: "locked while the index builds", "all rows deleted". */
  readonly notes: readonly DiagramNote[];
  /** True when the table itself is dropped or truncated. */
  readonly doomed: boolean;
}

export interface DiagramNote {
  readonly text: string;
  readonly severity: Severity;
  readonly statementIndex: number;
}

export interface DiagramEdge {
  readonly fromTable: string;
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
  /** `existing` is drawn plain; `added` is what this migration creates. */
  readonly origin: 'existing' | 'added';
  readonly severity: Severity;
  readonly note?: string;
  readonly statementIndex?: number;
}

export interface Diagram {
  readonly tables: readonly DiagramTable[];
  readonly edges: readonly DiagramEdge[];
}

/** Column-level impacts, keyed by table then column. */
type ColumnMarks = Map<string, Map<string, DiagramColumn>>;

export async function buildDiagram(
  adapter: DatabaseAdapter,
  findings: readonly Finding[],
): Promise<Diagram> {
  const tables = orderedTables(findings);
  if (tables.length === 0) {
    return { tables: [], edges: [] };
  }

  const marks: ColumnMarks = new Map();
  const notes = new Map<string, DiagramNote[]>();
  const severities = new Map<string, Severity[]>();
  const doomed = new Set<string>();
  const rowCounts = new Map<string, number>();
  const addedEdges: DiagramEdge[] = [];

  const mark = (table: string, column: string, value: DiagramColumn): void => {
    const byColumn = marks.get(table) ?? new Map<string, DiagramColumn>();
    // Keep the most severe impact when several statements touch one column.
    const existing = byColumn.get(column);
    if (
      !existing ||
      worst([existing.severity ?? 'safe', value.severity ?? 'safe']) === value.severity
    ) {
      byColumn.set(column, value);
    }
    marks.set(table, byColumn);
  };

  const note = (table: string, value: DiagramNote): void => {
    notes.set(table, [...(notes.get(table) ?? []), value]);
  };

  for (const finding of findings) {
    const table = finding.classification.table;
    if (!table) {
      continue;
    }

    severities.set(table, [...(severities.get(table) ?? []), finding.severity]);
    if (finding.tableRows !== undefined) {
      rowCounts.set(table, finding.tableRows);
    }

    const column = finding.classification.column;
    const shared = {
      severity: finding.severity,
      statementIndex: finding.statementIndex,
    };

    switch (finding.kind) {
      case 'drop_column':
        if (column) {
          mark(table, column, {
            name: column,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'drop',
            note: finding.rowCount ? `${format(finding.rowCount)} rows lose data` : 'empty',
            ...shared,
          });
        }
        break;

      case 'add_column':
        if (column) {
          mark(table, column, {
            name: column,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'add',
            note: 'new',
            ...shared,
          });
        }
        break;

      case 'set_not_null':
        if (column) {
          mark(table, column, {
            name: column,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'not_null',
            note: finding.rowCount ? `${format(finding.rowCount)} null` : 'no nulls',
            ...shared,
          });
        }
        break;

      case 'alter_column_type':
        if (column) {
          mark(table, column, {
            name: column,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'type',
            note: `→ ${finding.classification.newType ?? 'new type'}`,
            ...shared,
          });
        }
        break;

      case 'rename_column':
        if (column) {
          mark(table, column, {
            name: column,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'rename',
            note: 'renamed',
            ...shared,
          });
        }
        break;

      case 'add_unique':
        for (const name of finding.classification.columns ?? []) {
          mark(table, name, {
            name,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'unique',
            note: finding.rowCount ? `${format(finding.rowCount)} duplicates` : 'unique',
            ...shared,
          });
        }
        break;

      case 'create_index':
        for (const name of finding.classification.columns ?? []) {
          mark(table, name, {
            name,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'index',
            note: 'indexed',
            ...shared,
          });
        }
        note(table, {
          text: finding.classification.concurrently
            ? 'index built without locking'
            : 'locked while the index builds',
          severity: finding.severity,
          statementIndex: finding.statementIndex,
        });
        break;

      case 'add_foreign_key': {
        const reference = finding.classification.references;
        const columns = finding.classification.columns ?? [];
        if (reference && columns.length > 0) {
          for (const name of columns) {
            mark(table, name, {
              name,
              type: '',
              isPrimaryKey: false,
              nullable: true,
              impact: 'foreign_key',
              note: finding.rowCount ? `${format(finding.rowCount)} orphans` : 'all valid',
              ...shared,
            });
          }
          addedEdges.push({
            fromTable: table,
            fromColumn: columns[0]!,
            toTable: reference.table,
            toColumn: reference.columns[0] ?? 'id',
            origin: 'added',
            severity: finding.severity,
            ...(finding.rowCount ? { note: `${format(finding.rowCount)} orphans` } : {}),
            statementIndex: finding.statementIndex,
          });
        }
        break;
      }

      case 'drop_table':
      case 'truncate':
        doomed.add(table);
        note(table, {
          text:
            finding.kind === 'truncate'
              ? `emptied — ${format(finding.rowCount ?? 0)} rows`
              : `dropped — ${format(finding.rowCount ?? 0)} rows`,
          severity: finding.severity,
          statementIndex: finding.statementIndex,
        });
        break;

      case 'update':
      case 'delete':
      case 'insert':
        note(table, {
          text: `${format(finding.rowCount ?? 0)} rows ${
            finding.kind === 'delete' ? 'deleted' : finding.kind === 'insert' ? 'inserted' : 'updated'
          }`,
          severity: finding.severity,
          statementIndex: finding.statementIndex,
        });
        // Mark the columns an UPDATE actually changes, taken from the sample.
        for (const name of changedColumns(finding)) {
          mark(table, name, {
            name,
            type: '',
            isPrimaryKey: false,
            nullable: true,
            impact: 'written',
            note: 'value changes',
            ...shared,
          });
        }
        break;

      default:
        break;
    }
  }

  // The schema around the impacts, so the diagram reads as a table rather than
  // a list of warnings. Failure here is not fatal: a diagram of only the
  // touched columns is still useful.
  const schemas = new Map<string, ColumnInfo[]>();
  await Promise.all(
    tables.map(async (table) => {
      schemas.set(table, await adapter.tableColumns(table).catch(() => []));
    }),
  );

  const existing = await adapter.foreignKeys(tables).catch(() => []);

  const diagramTables: DiagramTable[] = tables.map((table) => {
    const columnMarks = marks.get(table) ?? new Map<string, DiagramColumn>();
    const schema = schemas.get(table) ?? [];

    const columns: DiagramColumn[] = schema.map((info) => {
      const marked = columnMarks.get(info.name);
      return {
        name: info.name,
        type: info.type,
        isPrimaryKey: info.isPrimaryKey,
        nullable: info.nullable,
        ...(marked
          ? {
              impact: marked.impact,
              severity: marked.severity,
              note: marked.note,
              statementIndex: marked.statementIndex,
            }
          : {}),
      };
    });

    // A column being added does not exist in the schema yet, so it is appended
    // rather than matched.
    for (const [name, marked] of columnMarks) {
      if (!schema.some((info) => info.name === name)) {
        columns.push({ ...marked, name });
      }
    }

    return {
      name: table,
      ...(rowCounts.has(table) ? { rows: rowCounts.get(table)! } : {}),
      severity: worst(severities.get(table) ?? ['safe']),
      columns,
      notes: notes.get(table) ?? [],
      doomed: doomed.has(table),
    };
  });

  const known = new Set(tables);
  const existingEdges: DiagramEdge[] = existing
    .filter((fk) => known.has(fk.fromTable) && known.has(fk.toTable))
    .filter(
      (fk) =>
        !addedEdges.some(
          (added) => added.fromTable === fk.fromTable && added.toTable === fk.toTable,
        ),
    )
    .map((fk) => ({
      fromTable: fk.fromTable,
      fromColumn: fk.fromColumns[0] ?? '',
      toTable: fk.toTable,
      toColumn: fk.toColumns[0] ?? '',
      origin: 'existing' as const,
      severity: 'safe' as const,
    }));

  return { tables: diagramTables, edges: [...addedEdges, ...existingEdges] };
}

/** Tables in the order the file first mentions them, plus FK targets. */
function orderedTables(findings: readonly Finding[]): string[] {
  const seen: string[] = [];
  const add = (table: string | undefined): void => {
    if (table && !seen.includes(table)) {
      seen.push(table);
    }
  };

  for (const finding of findings) {
    add(finding.classification.table);
    add(finding.classification.references?.table);
  }
  return seen;
}

function changedColumns(finding: Finding): string[] {
  const columns = new Set<string>();
  for (const row of finding.sample?.rows ?? []) {
    for (const column of row.changed) {
      columns.add(column);
    }
  }
  return [...columns];
}

function format(n: number): string {
  return n.toLocaleString('en-US');
}
