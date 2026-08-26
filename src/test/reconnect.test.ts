import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter, UncertainApplyError, isConnectionDead } from '../adapters/postgres';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Surviving the socket dying.
 *
 * The adapter holds one connection for the life of the session, and that
 * connection will die: a serverless Postgres suspends an idle compute, a laptop
 * closes its lid, a network drops. Before this, every query afterwards failed
 * with the same sentence for ever — "Client has encountered a connection error
 * and is not queryable" — with no way back but disconnecting by hand and
 * nothing on screen saying so.
 *
 * The connection is killed here from a second session, the way the server does
 * it, rather than by reaching into the adapter and setting a flag.
 */

describe('a connection that dies', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let killer: Client;

  before(async () => {
    fixture = await startPostgres();
    killer = new Client({ connectionString: fixture.connectionString });
    await killer.connect();

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await killer?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  /** Terminates the adapter's session the way an idle timeout would. */
  async function killTheAdaptersConnection(): Promise<void> {
    await killer.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [APPLICATION_NAME],
    );
    // The client learns about it asynchronously; a moment here makes the test
    // deterministic without changing what is being tested.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  it('recognises the sentence pg says for ever afterwards', () => {
    // No code on this one, only the message, which is why the text is matched.
    assert.equal(
      isConnectionDead(new Error('Client has encountered a connection error and is not queryable')),
      true,
    );
    assert.equal(isConnectionDead(new Error('Connection terminated unexpectedly')), true);
    assert.equal(isConnectionDead(Object.assign(new Error(''), { code: '57P01' })), true);
    assert.equal(isConnectionDead(Object.assign(new Error('nope'), { code: '42P01' })), false);
  });

  it('reads again after the connection is killed', async () => {
    assert.equal(await adapter.countRows('users'), 100);

    await killTheAdaptersConnection();

    // The failure this test exists for: before reconnecting, this threw for
    // ever and the panel showed the same sentence on every table.
    assert.equal(await adapter.countRows('users'), 100, 'it opened a new connection');
  });

  it('keeps working afterwards rather than reconnecting once and dying again', async () => {
    await killTheAdaptersConnection();
    assert.equal(await adapter.countRows('users'), 100);
    assert.equal(await adapter.countRows('orgs'), 2);
    assert.equal(await adapter.countNonNull('users', 'email'), 88);
  });

  it('survives it happening twice', async () => {
    await killTheAdaptersConnection();
    assert.equal(await adapter.countRows('users'), 100);
    await killTheAdaptersConnection();
    assert.equal(await adapter.countRows('users'), 100);
  });

  it('runs a preview again on the new connection', async () => {
    await killTheAdaptersConnection();

    // Safe to retry in full: nothing inside a preview can commit, so a socket
    // that died means the server already threw the transaction away.
    const counted = await adapter.withRollback(async (tx) => {
      const result = await tx.query(`SELECT COUNT(*)::int AS n FROM users`);
      return Number(result.rows[0]!['n']);
    });

    assert.equal(counted, 100);
  });

  it('still rolls back after reconnecting', async () => {
    await killTheAdaptersConnection();

    await adapter.withRollback(async (tx) => {
      await tx.query(`UPDATE users SET tier = 'enterprise'`);
    });

    assert.equal(
      await adapter.countRows('users', `tier = 'enterprise'`),
      0,
      'the retry is still a preview',
    );
  });

  it('still reads the schema after reconnecting', async () => {
    await killTheAdaptersConnection();
    const snapshot = await adapter.schemaSnapshot();
    assert.ok(snapshot.tables.length > 0);
  });

  describe('applying, which is the one thing it will not retry', () => {
    it('says it does not know rather than running it twice', async () => {
      // Everything else here reconnects and runs again because everything else
      // reads or rolls back. This commits, and a socket that dies during a
      // COMMIT leaves the outcome genuinely unknown.
      await killTheAdaptersConnection();

      // Force the failure to land inside the apply: the adapter notices the
      // socket is gone and reconnects first, so the statement below is what
      // has to fail. A statement that terminates its own backend does that.
      await assert.rejects(
        () =>
          adapter.runCommitted([
            {
              sql: `SELECT pg_terminate_backend(pg_backend_pid())`,
              params: [],
            },
          ]),
        (error: Error) =>
          error instanceof UncertainApplyError || isConnectionDead(error),
      );
    });

    it('says what to do about it', () => {
      const error = new UncertainApplyError('Connection terminated unexpectedly');
      assert.match(error.message, /does not know whether the changes went through/);
      assert.match(error.message, /applying twice is worse than applying once/);
      assert.match(error.message, /Check the database before running this again/);
    });

    it('works again once the connection is back', async () => {
      assert.equal(await adapter.countRows('users'), 100);
    });
  });
});
