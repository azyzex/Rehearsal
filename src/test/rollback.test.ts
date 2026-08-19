import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { TransactionControlError } from '../adapters/types';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * M0 acceptance tests.
 *
 * `withRollback` is the single most important correctness property in the
 * codebase: everything else in Dry Run is built on the promise that a preview
 * cannot change your data. These tests are written against a real Postgres,
 * and they verify the promise from the outside — by reading the table back on
 * a separate connection after the preview has finished.
 */

const PRO_USERS = 33; // i % 3 = 0 for i in 1..100

describe('withRollback', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;

  before(async () => {
    fixture = await startPostgres();

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });

    // A second, independent connection. Reading the table back through the
    // adapter's own connection would prove less: this one can only ever see
    // committed data.
    verifier = new Client({ connectionString: fixture.connectionString });
    await verifier.connect();
  });

  after(async () => {
    await verifier?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  const countPro = async (): Promise<number> => {
    const { rows } = await verifier.query(`SELECT COUNT(*)::int AS n FROM users WHERE tier = 'pro'`);
    return Number(rows[0].n);
  };

  it('reports the true rowCount of an UPDATE and then discards it', async () => {
    assert.equal(await countPro(), PRO_USERS, 'fixture precondition');

    const rowCount = await adapter.withRollback(async (tx) => {
      const result = await tx.query(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`);
      return result.rowCount;
    });

    assert.equal(rowCount, PRO_USERS, 'the server reports the real number of affected rows');
    assert.equal(await countPro(), PRO_USERS, 'and none of them actually changed');
  });

  it('sees its own uncommitted writes inside the transaction', async () => {
    // Without this, "rolled back" could be trivially satisfied by never
    // executing the statement at all. The preview is only useful because the
    // statement really runs.
    const insideCount = await adapter.withRollback(async (tx) => {
      await tx.query(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`);
      const { rows } = await tx.query(`SELECT COUNT(*)::int AS n FROM users WHERE tier = 'pro'`);
      return Number(rows[0]!['n']);
    });

    assert.equal(insideCount, 0, 'the update is visible within the transaction');
    assert.equal(await countPro(), PRO_USERS, 'and gone once it ends');
  });

  it('rolls back when the callback throws', async () => {
    const boom = new Error('analysis blew up halfway through');

    await assert.rejects(
      adapter.withRollback(async (tx) => {
        await tx.query(`DELETE FROM users WHERE tier = 'pro'`);
        throw boom;
      }),
      (error: unknown) => error === boom,
    );

    assert.equal(await countPro(), PRO_USERS, 'the DELETE did not survive the thrown error');
  });

  it('rolls back when a statement times out, and stays usable afterwards', async () => {
    const impatient = new PostgresAdapter();
    await impatient.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 300,
      lockTimeoutMs: 300,
      applicationName: APPLICATION_NAME,
    });

    try {
      await assert.rejects(
        impatient.withRollback(async (tx) => {
          await tx.query(`DELETE FROM users WHERE tier = 'pro'`);
          await tx.query('SELECT pg_sleep(3)');
        }),
      );

      assert.equal(await countPro(), PRO_USERS, 'the timed-out transaction changed nothing');

      const stillWorks = await impatient.withRollback(async (tx) => {
        const { rows } = await tx.query('SELECT 1 AS ok');
        return rows[0]!['ok'];
      });
      assert.equal(Number(stillWorks), 1, 'the connection recovered');
    } finally {
      await impatient.dispose();
    }
  });

  it('refuses transaction control smuggled in from a migration file', async () => {
    // A migration file containing a literal COMMIT would otherwise persist
    // everything the preview just did.
    await assert.rejects(
      adapter.withRollback(async (tx) => {
        await tx.query(`DELETE FROM users;`);
        await tx.query(`COMMIT;`);
      }),
      TransactionControlError,
    );

    assert.equal(await countPro(), PRO_USERS, 'nothing was committed');

    await assert.rejects(
      adapter.withRollback(async (tx) => {
        await tx.query(`UPDATE users SET tier = 'free'; COMMIT;`);
      }),
      TransactionControlError,
    );

    assert.equal(await countPro(), PRO_USERS, 'nothing was committed');
  });

  it('serializes overlapping previews on the single connection', async () => {
    const [a, b] = await Promise.all([
      adapter.withRollback(async (tx) => {
        await tx.query(`DELETE FROM users WHERE tier = 'pro'`);
        const { rows } = await tx.query(`SELECT COUNT(*)::int AS n FROM users`);
        return Number(rows[0]!['n']);
      }),
      adapter.withRollback(async (tx) => {
        const { rows } = await tx.query(`SELECT COUNT(*)::int AS n FROM users`);
        return Number(rows[0]!['n']);
      }),
    ]);

    assert.equal(a, 100 - PRO_USERS, 'the first preview saw its own delete');
    assert.equal(b, 100, 'the second preview never saw the first one');
  });

  it('tags its sessions so a DBA can identify them', async () => {
    const { rows } = await verifier.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`,
      [APPLICATION_NAME],
    );
    assert.ok(Number(rows[0].n) >= 1, 'application_name is set on the connection');
  });
});
