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

export interface Rehearsal {
  readonly ran: boolean;
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
    const copyMilliseconds = Date.now() - copyStarted;

    // From here, unqualified names resolve to the copies. The caller has
    // already refused statements that name a schema explicitly, which is the
    // only way one of these could reach an original.
    await tx.query(`SET LOCAL search_path = ${quote(REHEARSAL_SCHEMA)}, pg_catalog`);

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
      try {
        await tx.query(statement.sql, statement.params);
        statements.push({ index: statement.index, status: 'ran', milliseconds: Date.now() - started });
      } catch (error) {
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

    return { ran: true, copied, copyMilliseconds, statements };
  });
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
