import { Client } from 'pg';
import { QueryResult } from './types';

/**
 * The only file in Dry Run that commits.
 *
 * Everywhere else, a COMMIT is banned — by an ESLint rule and by a test that
 * scans the source. Both of those exempt exactly this file, and nothing else.
 * That is deliberate: rather than letting the ban weaken into "mostly", the
 * capability is confined to one short module whose entire purpose is to be read
 * carefully.
 *
 * What reaches here has already been previewed: really executed against the
 * real data inside a transaction that was rolled back, and reported with
 * measured numbers. `applyChangeset` refuses anything whose preview token does
 * not match the statements it was given, so "preview, change one more thing,
 * apply" cannot happen by accident.
 *
 * The whole changeset runs in one transaction. Half-applied migrations are the
 * failure mode this extension exists to warn about, and introducing one here
 * would be indefensible.
 */

export interface CommittableStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface CommittedResult {
  readonly applied: number;
  readonly rowCounts: readonly (number | null)[];
}

export async function runCommittedOn(
  client: Client,
  timeouts: { statementTimeoutMs: number; lockTimeoutMs: number },
  statements: readonly CommittableStatement[],
): Promise<CommittedResult> {
  const rowCounts: (number | null)[] = [];

  await client.query('BEGIN');
  try {
    // The same ceilings a preview runs under. Applying a change is not a reason
    // to be allowed to hold a lock queue open indefinitely.
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeouts.statementTimeoutMs)}`);
    await client.query(`SET LOCAL lock_timeout = ${Math.floor(timeouts.lockTimeoutMs)}`);

    for (const statement of statements) {
      const result: QueryResult = await client
        .query(statement.sql, statement.params ? [...statement.params] : undefined)
        .then((r) => ({ rows: r.rows, rowCount: r.rowCount }));
      rowCounts.push(result.rowCount);
    }

    await client.query('COMMIT');
    return { applied: statements.length, rowCounts };
  } catch (error) {
    // Any failure discards every edit in the set, including the ones that had
    // already succeeded. That is the point of the single transaction.
    await client.query('ROLLBACK').catch(() => {
      /* the connection is gone; the server discards it for us */
    });
    throw error;
  }
}
