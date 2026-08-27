import { DatabaseAdapter, Row, Transaction } from '../adapters/types';
import { Classification } from '../parser/classifier';
import { quoteIdent, qualify } from '../adapters/postgres';
import { AnalysedPlan, analysePlan, parsePlan } from './plan';
import { Sample, SampleRow, Thresholds } from './types';

/**
 * DML preview: really execute, look at what happened, throw it away.
 *
 * ## Getting the before-state
 *
 * The hard part is not the count — the driver reports that. It is showing the
 * row as it was *and* as it would become, without re-deriving the WHERE clause
 * by string manipulation, which subqueries, joins and CTEs make unreliable.
 *
 * The spec's own suggestion is to capture affected keys with RETURNING and read
 * the before-state from a snapshot. There is a cleaner way that needs no
 * snapshot and works on every Postgres version:
 *
 *   1. SAVEPOINT
 *   2. run the statement with RETURNING, capturing the affected primary keys
 *   3. read the *after* rows for those keys — the statement has run, so this
 *      is the new state
 *   4. ROLLBACK TO SAVEPOINT — the statement is undone, the table is back
 *   5. read the *before* rows for the same keys
 *
 * Both halves are real reads of real rows, matched by primary key, with no
 * guessing about which rows were hit. The outer transaction still rolls back
 * in its entirety afterwards; the savepoint only scopes step 4.
 *
 * ## When it declines
 *
 * No primary key, or a statement that already carries its own RETURNING
 * clause, means affected rows cannot be identified reliably. In that case the
 * count is still exact and the sample is reported as unavailable, because a
 * wrong sample is worse than no sample.
 */

export interface DmlResult {
  readonly rowCount: number;
  readonly sample: Sample;
  /** Present only when plan capture was asked for and succeeded. */
  readonly plan?: AnalysedPlan;
}

const SAVEPOINT = 'dryrun_stmt';
const PLAN_SAVEPOINT = 'dryrun_plan';

export async function analyzeDml(
  adapter: DatabaseAdapter,
  sql: string,
  classification: Classification,
  thresholds: Thresholds,
  params: readonly unknown[] = [],
): Promise<DmlResult> {
  const table = classification.table;

  // Metadata is read outside the transaction: the adapter serializes work on
  // its single connection, so a probe issued from inside `withRollback` would
  // wait for a transaction that is waiting for it.
  const pkColumns = table ? await adapter.primaryKeyColumns(table).catch(() => []) : [];

  const canSample =
    Boolean(table) && pkColumns.length > 0 && classification.hasReturning !== true;

  const declineReason = !table
    ? 'the target table could not be identified'
    : pkColumns.length === 0
      ? `${table} has no primary key, so affected rows cannot be matched up`
      : classification.hasReturning
        ? 'the statement has its own RETURNING clause'
        : undefined;

  return adapter.withRollback(async (tx) => {
    if (!canSample) {
      const result = await tx.query(sql, params);
      return {
        rowCount: result.rowCount ?? 0,
        sample: {
          rows: [],
          totalAffected: result.rowCount ?? 0,
          unavailable: `Sample unavailable: ${declineReason}.`,
        },
      };
    }

    await tx.savepoint(SAVEPOINT);

    // Qualified by the target table, because USING and FROM put a second
    // table in scope and a bare column name is then ambiguous — which fails
    // the statement and shows the user a parser error instead of a count.
    const target = classification.alias ?? table!;
    const keyList = pkColumns
      .map((column) => `${quoteIdent(bareName(target))}.${quoteIdent(column)}`)
      .join(', ');
    // `count(*) OVER ()` is evaluated across the whole CTE before LIMIT, so the
    // exact total comes back even though only a handful of rows are shipped.
    const limit = Math.max(1, Math.floor(thresholds.sampleSize));

    // Two ways to capture what a statement touched, because a data-modifying
    // CTE is a Postgres feature. SQLite has `RETURNING` and not the CTE, so it
    // gets the plain form and counts the rows that come back — which is exact,
    // and affordable in a way it would not be against a server, because the
    // database is a file on this machine and the whole thing is rolled back.
    const plain = adapter.engine === 'sqlite';
    const captured = await tx.query(
      plain
        ? `${stripTrailingSemicolon(sql)} RETURNING ${keyList}`
        : `WITH dryrun_affected AS (
         ${stripTrailingSemicolon(sql)}
         RETURNING ${keyList}
       )
       SELECT count(*) OVER () AS dryrun_total, *
         FROM dryrun_affected
        LIMIT ${limit}`,
      params,
    );

    const rowCount = plain
      ? captured.rows.length
      : captured.rows.length > 0
        ? Number(captured.rows[0]!['dryrun_total'])
        : 0;
    const keys = (plain ? captured.rows.slice(0, limit) : captured.rows).map((row) =>
      pick(row, pkColumns),
    );

    if (keys.length === 0) {
      await tx.rollbackTo(SAVEPOINT);
      return { rowCount, sample: { rows: [], totalAffected: rowCount } };
    }

    // Step 3: the new state. A DELETE has none by definition.
    const after =
      classification.kind === 'delete'
        ? new Map<string, Row>()
        : await fetchByKeys(tx, table!, pkColumns, keys);

    // Step 4: undo just this statement.
    await tx.rollbackTo(SAVEPOINT);

    // Step 5: the old state. An INSERT has none by definition.
    const before =
      classification.kind === 'insert'
        ? new Map<string, Row>()
        : await fetchByKeys(tx, table!, pkColumns, keys);

    // The plan, when it was asked for.
    //
    // It has to run *after* the rollback, in a savepoint of its own. Capturing
    // it while the statement's effects were still in place measured a different
    // execution than the one being reported: a DELETE whose rows had already
    // gone matched nothing the second time, so the plan described an empty
    // statement while the row count beside it said 150,000. It now sees exactly
    // the table the real statement saw.
    let plan: AnalysedPlan | undefined;
    if (thresholds.explainAnalyze) {
      plan = await capturePlan(tx, sql, params, thresholds);
    }

    const rows: SampleRow[] = keys.map((key) => {
      const id = keyOf(key, pkColumns);
      const beforeRow = before.get(id) ?? null;
      const afterRow = after.get(id) ?? null;
      return {
        key,
        before: beforeRow,
        after: afterRow,
        changed: changedColumns(beforeRow, afterRow),
      };
    });

    return {
      rowCount,
      ...(plan ? { plan } : {}),
      sample: {
        rows,
        totalAffected: rowCount,
        // A DELETE or INSERT has no before/after pair to compare, so every
        // sampled row counts as a change.
        changedInSample:
          classification.kind === 'update'
            ? rows.filter((row) => row.changed.length > 0).length
            : rows.length,
      },
    };
  });
}

/** Columns whose value differs. Empty when one side does not exist. */
function changedColumns(before: Row | null, after: Row | null): string[] {
  if (!before || !after) {
    return [];
  }
  return Object.keys(before).filter((column) => !sameValue(before[column], after[column]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

async function fetchByKeys(
  tx: Transaction,
  table: string,
  pkColumns: readonly string[],
  keys: readonly Record<string, unknown>[],
): Promise<Map<string, Row>> {
  const params: unknown[] = [];
  const tuples = keys.map((key) => {
    const placeholders = pkColumns.map((column) => {
      params.push(key[column]);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const keyList = pkColumns.map(quoteIdent).join(', ');
  const { rows } = await tx.query(
    `SELECT * FROM ${qualify(table)} WHERE (${keyList}) IN (${tuples.join(', ')})`,
    params,
  );

  const byKey = new Map<string, Row>();
  for (const row of rows) {
    byKey.set(keyOf(row, pkColumns), row);
  }
  return byKey;
}

function pick(row: Row, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[column] = row[column];
  }
  return out;
}

/**
 * Stable identity for a row, so before and after can be paired up.
 *
 * JSON rather than a delimiter join: a composite key whose values contain the
 * delimiter would otherwise collide, and pairing the wrong before-row with the
 * wrong after-row is exactly the class of quiet wrongness this tool exists to
 * avoid.
 */
function keyOf(row: Record<string, unknown>, columns: readonly string[]): string {
  return JSON.stringify(columns.map((c) => row[c]));
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '');
}

/**
 * Captures a plan for the statement that just ran.
 *
 * A failure here is not a failure of the preview. The measurements are already
 * taken; a missing plan makes the row less informative, not wrong, so this
 * swallows its own errors rather than taking the analysis down with it.
 */
async function capturePlan(
  tx: Transaction,
  sql: string,
  params: readonly unknown[],
  thresholds: Thresholds,
): Promise<AnalysedPlan | undefined> {
  try {
    // Its own savepoint: ANALYZE really executes, and its effects must not
    // survive into the before/after that has already been read.
    await tx.savepoint(PLAN_SAVEPOINT);
    const { rows } = await tx.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${stripTrailingSemicolon(sql)}`,
      params,
    );
    await tx.rollbackTo(PLAN_SAVEPOINT);

    const node = parsePlan(rows[0]?.['QUERY PLAN']);
    return node
      ? analysePlan(node, {
          largeTable: thresholds.largeTable,
          estimateFactor: 10,
        })
      : undefined;
  } catch {
    await tx.rollbackTo(PLAN_SAVEPOINT).catch(() => undefined);
    return undefined;
  }
}

/** The table name without its schema, which is how a column is qualified. */
function bareName(table: string): string {
  const parts = table.split('.');
  return (parts[parts.length - 1] ?? table).replace(/^"|"$/g, '');
}
