import { Transaction } from './types';

/**
 * A migration run for real, against copies of its tables, and timed.
 *
 * The preview measures what a schema change will do by counting, because
 * running an `ALTER TABLE` means taking its lock on the real table — and an
 * ACCESS EXCLUSIVE lock held for a minute on a staging database is an outage
 * someone else is having. So the one thing the preview can only estimate is
 * the thing people most want: how long the lock is held.
 *
 * This measures it. Inside one transaction that is always rolled back:
 *
 *   1. copy each table the migration touches into a scratch schema — reading
 *      the originals takes ACCESS SHARE, which blocks nobody's writes;
 *   2. point `search_path` at the copies;
 *   3. run every statement for real, timing each one;
 *   4. roll back — copies, schema, and every change with them.
 *
 * Nothing needs cleaning up afterwards, because nothing was ever committed.
 * The heavy locks are taken on tables that exist for a few seconds inside one
 * transaction and that nobody else can see.
 *
 * What it cannot tell you: anything about contention. A copy has no traffic,
 * so a statement that would queue behind a long transaction in production
 * runs straight through here. The lock *duration* is real; whether anyone was
 * waiting for it is what the preview's queue check answers.
 */

export interface RehearsedStatement {
  readonly index: number;
  readonly status: 'ran' | 'failed' | 'not reached' | 'skipped';
  /** Wall-clock, for a statement that ran or failed. */
  readonly milliseconds?: number;
  readonly error?: string;
  /** Why a statement was skipped. */
  readonly reason?: string;
}

/** One of the database's busiest queries, planned before and after. */
export interface QueryCost {
  readonly query: string;
  readonly before?: PlanSummary;
  readonly after?: PlanSummary;
  /** Why it could not be planned, when it could not. */
  readonly unplanned?: string;
}

export interface PlanSummary {
  readonly cost: number;
  /** Scan nodes, like "Seq Scan on orders" or "Index Scan using idx_x on orders". */
  readonly scans: readonly string[];
}

export interface Rehearsal {
  readonly ran: boolean;
  /**
   * The busiest queries touching the copied tables, planned on the copies
   * before and after the migration. Absent when there was nowhere to read
   * them from: pg_stat_statements is an extension, and not everyone has it.
   */
  readonly queries?: readonly QueryCost[];
  /** Why the queries were not measured, when they were not. */
  readonly queriesSkipped?: string;
  /** Why it did not run at all. */
  readonly skipped?: string;
  /** The tables copied, with their row counts. */
  readonly copied: readonly { table: string; rows: number }[];
  /** How long making the copies took, which is not part of the migration. */
  readonly copyMilliseconds: number;
  readonly statements: readonly RehearsedStatement[];
}

export interface RehearsalInput {
  /** Tables to copy, as the migration names them. */
  readonly tables: readonly string[];
  readonly statements: readonly {
    readonly index: number;
    readonly sql: string;
    readonly params?: readonly unknown[];
    /** Set by the caller for a statement that must not be run here. */
    readonly skip?: string;
  }[];
}

/** Reserved; anything under it is Rehearsal's and lives for one transaction. */
export const REHEARSAL_SCHEMA = 'rehearsal_copy';

export async function rehearseOnCopy(
  withRollback: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>,
  quote: (identifier: string) => string,
  input: RehearsalInput,
): Promise<Rehearsal> {
  return withRollback(async (tx) => {
    // The copies take as long as they take; the configured statement timeout
    // is for previews. The lock timeout is left alone on purpose: if the
    // original is locked, waiting for it is exactly what not to do.
    await tx.query(`SET LOCAL statement_timeout = '15min'`);

    const copyStarted = Date.now();
    await tx.query(`CREATE SCHEMA ${quote(REHEARSAL_SCHEMA)}`);

    const copied: { table: string; rows: number }[] = [];
    for (const table of input.tables) {
      const source = qualifiedFor(table, quote);
      const target = `${quote(REHEARSAL_SCHEMA)}.${quote(bare(table))}`;
      // INCLUDING ALL brings defaults, constraints and indexes — so an index
      // build or a constraint check on the copy does the work it would do on
      // the original. Foreign keys are not copied, as with LIKE everywhere.
      await tx.query(`CREATE TABLE ${target} (LIKE ${source} INCLUDING ALL)`);
      const inserted = await tx.query(`INSERT INTO ${target} SELECT * FROM ${source}`);
      copied.push({ table, rows: inserted.rowCount ?? 0 });
    }
    // Statistics for the copies, or the planner costs below would be costs
    // of tables it believes are empty. ANALYZE may run inside a transaction.
    for (const table of input.tables) {
      await tx.query(`ANALYZE ${quote(REHEARSAL_SCHEMA)}.${quote(bare(table))}`);
    }
    const copyMilliseconds = Date.now() - copyStarted;

    // The queries worth measuring, read before the search path moves: the
    // statistics view lives in the public schema or wherever it was installed.
    const busiest = await busiestQueries(tx, input.tables);

    // From here, unqualified names resolve to the copies. The caller has
    // already refused statements that name a schema explicitly, which is the
    // only way one of these could reach an original.
    await tx.query(`SET LOCAL search_path = ${quote(REHEARSAL_SCHEMA)}, pg_catalog`);

    const before = new Map<string, PlanSummary | string>();
    for (const query of busiest.queries) {
      before.set(query, await planOf(tx, query));
    }

    const statements: RehearsedStatement[] = [];
    let stopped = false;

    for (const statement of input.statements) {
      if (stopped) {
        statements.push({ index: statement.index, status: 'not reached' });
        continue;
      }
      if (statement.skip) {
        statements.push({ index: statement.index, status: 'skipped', reason: statement.skip });
        continue;
      }

      const started = Date.now();
      // In a savepoint, so a failure leaves the transaction usable for the
      // after-plans: the state they see is the migration up to where it stopped.
      await tx.savepoint('rehearsal_step');
      try {
        await tx.query(statement.sql, statement.params);
        statements.push({ index: statement.index, status: 'ran', milliseconds: Date.now() - started });
      } catch (error) {
        await tx.rollbackTo('rehearsal_step');
        statements.push({
          index: statement.index,
          status: 'failed',
          milliseconds: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        // A migration stops at its first failure, so the rehearsal does too:
        // what comes after never runs for real either.
        stopped = true;
      }
    }

    // After: fresh statistics, because a retyped column or a new index
    // changes what the planner knows, then the same queries again.
    const queries: QueryCost[] = [];
    if (busiest.queries.length > 0) {
      for (const table of input.tables) {
        await tx.query(`ANALYZE ${quote(bare(table))}`).catch(() => undefined);
      }
      for (const query of busiest.queries) {
        const earlier = before.get(query);
        const later = await planOf(tx, query);
        if (typeof earlier === 'string' || typeof later === 'string') {
          queries.push({
            query,
            unplanned: typeof earlier === 'string' ? earlier : String(later),
          });
        } else {
          queries.push({ query, before: earlier, after: later });
        }
      }
    }

    return {
      ran: true,
      copied,
      copyMilliseconds,
      statements,
      ...(busiest.queries.length > 0 ? { queries } : {}),
      ...(busiest.skipped ? { queriesSkipped: busiest.skipped } : {}),
    };
  });
}

/**
 * The busiest queries that mention a copied table, from pg_stat_statements.
 *
 * Normalised queries carry $1 placeholders rather than values, so they are
 * planned with EXPLAIN (GENERIC_PLAN), which needs Postgres 16. Nothing is
 * executed: a plan is the planner's answer, and it is all this compares.
 */
async function busiestQueries(
  tx: Transaction,
  tables: readonly string[],
): Promise<{ queries: string[]; skipped?: string }> {
  if (tables.length === 0) {
    return { queries: [] };
  }

  const version = await tx.query(`SELECT current_setting('server_version_num')::int AS v`);
  if (Number(version.rows[0]?.['v'] ?? 0) < 160000) {
    return {
      queries: [],
      skipped:
        'Queries were not planned: it needs Postgres 16, the first that can plan a query ' +
        'with placeholders in it without values for them.',
    };
  }

  await tx.savepoint('rehearsal_queries');
  try {
    const patterns = tables.map((table) => `%${bare(table).toLowerCase()}%`);
    const result = await tx.query(
      `SELECT query FROM pg_stat_statements
        WHERE lower(query) LIKE ANY ($1::text[])
          AND query ~* '^\\s*(select|with)\\b'
        ORDER BY total_exec_time DESC
        LIMIT 10`,
      [patterns],
    );
    return { queries: result.rows.map((row) => String(row['query'])) };
  } catch {
    await tx.rollbackTo('rehearsal_queries');
    return {
      queries: [],
      skipped:
        'Queries were not planned: pg_stat_statements is not installed here, or this role ' +
        'cannot read it. With it, the report shows what the migration does to the busiest ' +
        'queries on these tables.',
    };
  }
}

/** A plan's cost and scans, or why it could not be planned. */
async function planOf(tx: Transaction, query: string): Promise<PlanSummary | string> {
  await tx.savepoint('rehearsal_plan');
  try {
    const result = await tx.query(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${query}`);
    const raw = result.rows[0]?.['QUERY PLAN'];
    const plan = (Array.isArray(raw) ? raw[0] : JSON.parse(String(raw))[0])?.Plan;
    const scans: string[] = [];
    collectScans(plan, scans);
    return { cost: Number(plan?.['Total Cost'] ?? 0), scans };
  } catch (error) {
    await tx.rollbackTo('rehearsal_plan');
    return error instanceof Error ? error.message : String(error);
  }
}

function collectScans(node: Record<string, unknown> | undefined, into: string[]): void {
  if (!node) {
    return;
  }
  const type = String(node['Node Type'] ?? '');
  if (/Scan$/.test(type) && node['Relation Name']) {
    const index = node['Index Name'] ? ` using ${String(node['Index Name'])}` : '';
    into.push(`${type}${index} on ${String(node['Relation Name'])}`);
  }
  for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? []) {
    collectScans(child, into);
  }
}

function bare(table: string): string {
  const parts = table.split('.');
  return (parts[parts.length - 1] ?? table).replace(/"/g, '');
}

function qualifiedFor(table: string, quote: (identifier: string) => string): string {
  return table
    .split('.')
    .map((part) => quote(part.replace(/"/g, '')))
    .join('.');
}
