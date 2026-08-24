import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { SchemaHealth } from '../adapters/types';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The state of the schema itself.
 *
 * These are catalogue queries, and catalogue queries are the easiest thing in
 * this codebase to get subtly wrong: they run, they return rows, and the rows
 * are about the wrong thing. So the fixture is built with one of each problem
 * present and one of each deliberately absent, and both halves are asserted.
 */

describe('schema health', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let db: Client;
  let health: SchemaHealth;

  before(async () => {
    fixture = await startPostgres();
    db = new Client({ connectionString: fixture.connectionString });
    await db.connect();

    await db.query(`
      CREATE TABLE tenants (id serial PRIMARY KEY, name text NOT NULL);

      CREATE TABLE tickets (
        id        serial PRIMARY KEY,
        tenant_id int NOT NULL REFERENCES tenants (id),
        assignee  int,
        state     text NOT NULL,
        subject   text
      );

      -- Indexed on the leading column, so this foreign key is served.
      CREATE TABLE comments (
        id        serial PRIMARY KEY,
        ticket_id int NOT NULL REFERENCES tickets (id),
        body      text
      );
      CREATE INDEX comments_ticket ON comments (ticket_id, id);

      -- (state) is a leading subset of (state, subject): anything the short
      -- one answers, the long one answers too.
      CREATE INDEX tickets_state       ON tickets (state);
      CREATE INDEX tickets_state_subj  ON tickets (state, subject);

      -- A partial index over the same column is NOT redundant: it answers a
      -- different question and is a fraction of the size.
      CREATE INDEX tickets_open ON tickets (state) WHERE state = 'open';

      INSERT INTO tenants (name) SELECT 'tenant ' || i FROM generate_series(1, 5) AS i;
      INSERT INTO tickets (tenant_id, assignee, state, subject)
      SELECT 1 + (i % 5), i % 3, CASE WHEN i % 4 = 0 THEN 'open' ELSE 'closed' END, 'subject ' || i
      FROM generate_series(1, 2000) AS i;
      INSERT INTO comments (ticket_id, body)
      SELECT 1 + (i % 2000), 'body' FROM generate_series(1, 500) AS i;

      ANALYZE tenants, tickets, comments;
    `);

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });

    // The statistics collector writes asynchronously, so a snapshot taken the
    // instant after seeding reports a table nobody has ever touched. Waiting
    // for the rows to land is the difference between testing the queries and
    // testing a race.
    health = await waitFor(
      () => adapter.schemaHealth(),
      (snapshot) =>
        (snapshot.tables.find((table) => table.table === 'tickets')?.liveRows ?? 0) >= 2000,
    );
  });

  /** Re-reads until the collector has caught up, or gives up and lets the assertion fail. */
  async function waitFor(
    read: () => Promise<SchemaHealth>,
    ready: (snapshot: SchemaHealth) => boolean,
  ): Promise<SchemaHealth> {
    let snapshot = await read();
    for (let attempt = 0; attempt < 100 && !ready(snapshot); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = await read();
    }
    return snapshot;
  }

  after(async () => {
    await db?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  it('reports the window the statistics cover', () => {
    // Without this every other number here is unreadable: "never scanned" and
    // "not scanned since the server came up ninety seconds ago" are the same
    // row of pg_stat_user_indexes and completely different facts.
    assert.ok(health.statsSince instanceof Date);
    assert.ok(health.statsSince!.getTime() <= Date.now());
  });

  describe('foreign keys with nothing behind them', () => {
    it('finds the one with no index', () => {
      const found = health.unindexedForeignKeys.find((fk) => fk.table === 'tickets');
      assert.ok(found, 'tickets.tenant_id has no index');
      assert.deepEqual(found!.columns, ['tenant_id']);
      assert.equal(found!.referencedTable, 'tenants');
      assert.ok(found!.rows >= 2000, 'the size of the child table is what decides if it matters');
    });

    it('does not flag one whose column leads an index', () => {
      // comments_ticket is (ticket_id, id). The key's column is its first, so
      // the planner will use it and the key is served.
      assert.equal(
        health.unindexedForeignKeys.some((fk) => fk.table === 'comments'),
        false,
      );
    });

    it('flags one whose column is not the leading column', async () => {
      await db.query('DROP INDEX comments_ticket');
      await db.query('CREATE INDEX comments_body_ticket ON comments (body, ticket_id)');

      const again = await adapter.schemaHealth();
      assert.ok(
        again.unindexedForeignKeys.some((fk) => fk.table === 'comments'),
        'an index that mentions the column somewhere does not serve the key',
      );

      await db.query('DROP INDEX comments_body_ticket');
      await db.query('CREATE INDEX comments_ticket ON comments (ticket_id, id)');
    });
  });

  describe('redundant indexes', () => {
    it('finds the short one that the long one covers', () => {
      const found = health.redundantIndexes.find((index) => index.index === 'tickets_state');
      assert.ok(found, '(state) is covered by (state, subject)');
      assert.equal(found!.coveredBy, 'tickets_state_subj');
      assert.equal(found!.table, 'tickets');
      assert.ok(found!.bytes > 0);
    });

    it('does not call the longer one redundant', () => {
      assert.equal(
        health.redundantIndexes.some((index) => index.index === 'tickets_state_subj'),
        false,
      );
    });

    it('leaves a partial index alone', () => {
      // Same column, different question, a fraction of the size. Dropping it
      // because a wider index exists would be wrong.
      assert.equal(
        health.redundantIndexes.some((index) => index.index === 'tickets_open'),
        false,
      );
    });

    it('never calls a primary key or a unique constraint redundant', () => {
      // They are not there to be read, they enforce a rule — and dropping one
      // for being unread drops the rule with it.
      for (const index of health.redundantIndexes) {
        assert.doesNotMatch(index.index, /_pkey$|_key$/);
      }
    });
  });

  describe('indexes nothing reads', () => {
    it('lists the ones with no scans, largest first', () => {
      const names = health.unusedIndexes.map((index) => index.index);
      assert.ok(names.includes('tickets_state_subj'));
      const sizes = health.unusedIndexes.map((index) => index.bytes);
      assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
    });

    it('leaves out the primary keys and unique constraints', () => {
      for (const index of health.unusedIndexes) {
        assert.doesNotMatch(index.index, /_pkey$/);
      }
    });

    it('stops listing one once something scans it', async () => {
      const query = `SELECT id FROM tickets WHERE state = 'closed' AND subject = 'subject 3'`;

      await db.query('SET enable_seqscan = off');
      // Which index the planner picks is its decision, not this test's, so the
      // plan is read rather than assumed. Asserting against a hard-coded name
      // would turn a planner preference into a test failure.
      const plan = await db.query(`EXPLAIN (FORMAT JSON) ${query}`);
      const scanned = JSON.stringify(plan.rows[0]['QUERY PLAN']).match(/"Index Name":"([^"]+)"/)?.[1];
      assert.ok(scanned, 'the query has to use an index for this test to mean anything');

      await db.query(query);
      await db.query('SET enable_seqscan = on');

      const again = await waitFor(
        () => adapter.schemaHealth(),
        (snapshot) => !snapshot.unusedIndexes.some((index) => index.index === scanned),
      );
      assert.equal(
        again.unusedIndexes.some((index) => index.index === scanned),
        false,
        `${scanned} was scanned but is still listed as unread. Still listed: ` +
          again.unusedIndexes.map((index) => index.index).join(', '),
      );
    });

    it('carries the definition, so the row says what would be dropped', () => {
      for (const index of health.unusedIndexes) {
        assert.match(index.definition, /^CREATE( UNIQUE)? INDEX/);
      }
    });
  });

  describe('table statistics', () => {
    it('reports live rows, dead rows and when each table was last looked at', () => {
      const tickets = health.tables.find((table) => table.table === 'tickets');
      assert.ok(tickets);
      assert.ok(tickets!.liveRows >= 2000);
      assert.equal(tickets!.deadRows, 0);
      assert.ok(tickets!.lastAnalyze instanceof Date, 'the fixture runs ANALYZE');
      assert.ok(tickets!.bytes > 0);
    });

    it('notices rows changed since the planner last looked', async () => {
      await db.query(`UPDATE tickets SET state = 'open' WHERE id <= 100`);

      const again = await waitFor(
        () => adapter.schemaHealth(),
        (snapshot) =>
          (snapshot.tables.find((table) => table.table === 'tickets')?.modifiedSinceAnalyze ?? 0) >=
          100,
      );
      const modified =
        again.tables.find((table) => table.table === 'tickets')?.modifiedSinceAnalyze ?? 0;
      assert.ok(modified >= 100, 'stale statistics are why a planner picks the wrong plan');
    });

    it('orders by size, because that is the order anyone reads it in', () => {
      const sizes = health.tables.map((table) => table.bytes);
      assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
    });
  });
});
