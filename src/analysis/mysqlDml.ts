import { DatabaseAdapter, Row } from '../adapters/types';
import { Classification } from '../parser/classifier';
import { Sample, Thresholds } from './types';

/**
 * Running a MySQL write, and undoing it.
 *
 * The Postgres version appends `RETURNING` to learn exactly which rows a
 * statement touched — including rows a join dragged in, which the WHERE clause
 * alone would never reveal. MySQL has no `RETURNING` at all, so the same
 * question has to be asked before the fact: select the rows the statement will
 * match, remember their keys, run it, and read the same keys back.
 *
 * That is very nearly as good and honestly worse in one case, which is stated
 * rather than hidden. For an `UPDATE … JOIN`, the rows the statement really
 * changes can differ from the rows the WHERE clause selects on its own, so the
 * sample is marked as approximate. The count is not affected: it comes from the
 * server's own affected-rows number, which is exact either way.
 */

export interface MysqlDmlOutcome {
  readonly rowCount: number;
  readonly sample?: Sample;
}

const SAMPLE_CAP = 50;

export async function analyzeMysqlDml(
  adapter: DatabaseAdapter,
  statement: string,
  classification: Classification,
  thresholds: Thresholds,
  params: readonly unknown[],
): Promise<MysqlDmlOutcome> {
  const table = classification.table;
  const limit = Math.max(1, Math.min(thresholds.sampleSize, SAMPLE_CAP));

  return adapter.withRollback(async (tx) => {
    const inserting = classification.kind === 'insert';

    // Without a table or a key there is nothing to follow, so the count is
    // reported alone rather than beside a sample of the wrong rows.
    const keys = inserting || !table ? [] : await adapter.primaryKeyColumns(table);
    const where = whereClauseOf(statement);

    const before =
      keys.length > 0 && where !== undefined
        ? await select(tx, table!, keys, where, limit, params)
        : [];

    const result = await tx.query(statement, params);
    const rowCount = result.rowCount ?? 0;

    if (before.length === 0) {
      return { rowCount };
    }

    const after = await selectByKeys(tx, table!, keys, before, params);
    const afterByKey = new Map(after.map((row) => [keyOf(row, keys), row]));

    const rows = before.map((row) => {
      const updated = afterByKey.get(keyOf(row, keys));
      return {
        key: Object.fromEntries(keys.map((key) => [key, row[key]])),
        before: row,
        // Gone means deleted, which is what an absent `after` means everywhere
        // else in the panel.
        after: updated ?? null,
        changed: changedColumns(row, updated),
      };
    });

    return {
      rowCount,
      sample: {
        rows,
        totalAffected: rowCount,
        changedInSample: rows.filter((row) => row.changed.length > 0).length,
        ...(isJoined(statement)
          ? {
              unavailable:
                'These are the rows the WHERE clause selects. This statement joins another ' +
                'table, and MySQL has no RETURNING, so the rows it really changes may differ. ' +
                'The count above is the server’s own and is exact.',
            }
          : {}),
      },
    };
  });
}

/** The predicate, or undefined when there is none to reuse. */
function whereClauseOf(statement: string): string | undefined {
  // Only the simple shape. A statement with a subquery, a LIMIT or an ORDER BY
  // after the predicate would need real parsing, and guessing at the boundary
  // produces a sample of the wrong rows.
  const match = /\bWHERE\b([\s\S]+?)(?:\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(statement);
  if (!match) {
    // No WHERE at all means every row, which is a perfectly good predicate.
    return /\b(UPDATE|DELETE)\b/i.test(statement) ? '1 = 1' : undefined;
  }
  return match[1]!.trim();
}

function isJoined(statement: string): boolean {
  return /\bJOIN\b/i.test(statement) || /\bUPDATE\b[^]*?,[^]*?\bSET\b/i.test(statement);
}

async function select(
  tx: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }> },
  table: string,
  keys: readonly string[],
  where: string,
  limit: number,
  params: readonly unknown[],
): Promise<Row[]> {
  const result = await tx.query(
    `SELECT * FROM ${quote(table)} WHERE ${where} LIMIT ${Math.floor(limit)}`,
    params,
  );
  void keys;
  return result.rows;
}

async function selectByKeys(
  tx: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }> },
  table: string,
  keys: readonly string[],
  rows: readonly Row[],
  params: readonly unknown[],
): Promise<Row[]> {
  const predicate = rows
    .map(
      (row) =>
        `(${keys
          .map((key) => `${quote(key)} = ${literal(row[key])}`)
          .join(' AND ')})`,
    )
    .join(' OR ');

  const result = await tx.query(
    `SELECT * FROM ${quote(table)} WHERE ${predicate}`,
    params.length > 0 ? [] : [],
  );
  return result.rows;
}

function keyOf(row: Row, keys: readonly string[]): string {
  return JSON.stringify(keys.map((key) => String(row[key])));
}

function changedColumns(before: Row, after: Row | undefined): string[] {
  if (!after) {
    return Object.keys(before);
  }
  return Object.keys(before).filter(
    (column) => JSON.stringify(before[column]) !== JSON.stringify(after[column]),
  );
}

/**
 * A key value as SQL text.
 *
 * Only ever a primary key read straight back from the same server a moment
 * ago, so the range of things it can be is narrow — but it is still escaped
 * properly rather than interpolated, because "it can only be an id" is how
 * every injection starts.
 */
function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`;
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function quote(identifier: string): string {
  return identifier
    .replace(/`/g, '')
    .split('.')
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed.length === 0 || trimmed.includes('\0')) {
        throw new Error(`Invalid identifier: ${JSON.stringify(identifier)}`);
      }
      return `\`${trimmed}\``;
    })
    .join('.');
}
