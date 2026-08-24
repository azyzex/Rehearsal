import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { HypotheticalIndexUnavailableError, QueryPlan } from '../adapters/types';
import { filterColumns, indexCandidates, rowsRead, seqScans } from '../analysis/indexAdvice';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Index advice, and the experiment that checks it.
 *
 * The filter parsing is the part most likely to be quietly wrong, so it is
 * tested against strings Postgres really emits rather than against strings
 * that seemed plausible when this was written — the integration test at the
 * bottom is what keeps the two in step.
 */

describe('index advice', () => {
  describe('reading columns out of a filter', () => {
    const columns = ['id', 'tenant_id', 'kind', 'created_at', 'payload'];

    it('separates the equality tests from the range ones', () => {
      const found = filterColumns(
        `((tenant_id = 42) AND (created_at > '2024-01-01'::timestamptz))`,
        columns,
      );
      assert.deepEqual(found.equality, ['tenant_id']);
      assert.deepEqual(found.range, ['created_at']);
    });

    it('sees through the cast Postgres puts around a text comparison', () => {
      // The shape a `WHERE kind = 'click'` predicate actually comes back as.
      const found = filterColumns(`((kind)::text = 'click'::text)`, columns);
      assert.deepEqual(found.equality, ['kind']);
    });

    it('reads a qualified column when the qualifier is this table', () => {
      const found = filterColumns(`(e.tenant_id = 42)`, columns, 'e');
      assert.deepEqual(found.equality, ['tenant_id']);
    });

    it('ignores a column belonging to the other side of a join', () => {
      // `u.tenant_id` is not this scan's column even though the name matches,
      // and indexing this table on it would be pointless.
      const found = filterColumns(`(e.tenant_id = u.tenant_id)`, columns, 'e');
      assert.deepEqual(found.equality, ['tenant_id'], 'only the one that is ours');
    });

    it('does not treat an inequality as something a btree narrows', () => {
      const found = filterColumns(`(kind <> 'click'::text)`, columns);
      assert.deepEqual(found.equality, []);
      assert.deepEqual(found.range, []);
    });

    it('does not offer a plain index for a column wrapped in a function', () => {
      // `length(payload) = 4` needs an expression index. A btree on `payload`
      // answers nothing here, and offering one is worse than offering nothing.
      assert.deepEqual(filterColumns(`(length(payload) = 4)`, columns).equality, []);
      assert.deepEqual(filterColumns(`(lower(kind) = 'click'::text)`, columns).equality, []);
    });

    it('still reads a column that is only wrapped in grouping parens', () => {
      // The difference from the case above is one token: what opened the paren.
      assert.deepEqual(filterColumns(`(((kind)::text = 'click'::text))`, columns).equality, [
        'kind',
      ]);
    });

    it('lists a column once however many times the filter mentions it', () => {
      const found = filterColumns(`((tenant_id = 1) OR (tenant_id = 2))`, columns);
      assert.deepEqual(found.equality, ['tenant_id']);
    });
  });

  describe('candidates', () => {
    const plan = (node: unknown): QueryPlan => ({ raw: [{ Plan: node }] });
    const columnsByTable = new Map([['events', ['id', 'tenant_id', 'kind']]]);

    it('leaves a small scan alone', () => {
      // Below the threshold a sequential scan is the right plan, and an index
      // is write overhead bought with nothing.
      const found = indexCandidates(
        plan({
          'Node Type': 'Seq Scan',
          'Relation Name': 'events',
          Alias: 'events',
          Filter: '(tenant_id = 1)',
          'Rows Removed by Filter': 40,
          'Actual Rows': 2,
        }),
        { columnsByTable },
      );
      assert.deepEqual(found, []);
    });

    it('leaves a scan with no filter alone', () => {
      const found = indexCandidates(
        plan({
          'Node Type': 'Seq Scan',
          'Relation Name': 'events',
          Alias: 'events',
          'Rows Removed by Filter': 0,
          'Actual Rows': 900_000,
        }),
        { columnsByTable },
      );
      assert.deepEqual(found, [], 'it reads the table because the query asked for the table');
    });

    it('puts the worst scan first', () => {
      const found = indexCandidates(
        plan({
          'Node Type': 'Nested Loop',
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'events',
              Alias: 'events',
              Filter: '(tenant_id = 1)',
              'Rows Removed by Filter': 5000,
              'Actual Rows': 1,
            },
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'other',
              Alias: 'other',
              Filter: '(kind = 1)',
              'Rows Removed by Filter': 900_000,
              'Actual Rows': 1,
            },
          ],
        }),
        {
          columnsByTable: new Map([
            ['events', ['id', 'tenant_id', 'kind']],
            ['other', ['id', 'kind']],
          ]),
        },
      );
      assert.deepEqual(
        found.map((candidate) => candidate.table),
        ['other', 'events'],
      );
    });

    it('reports rows read as examined, not as returned', () => {
      const [scan] = seqScans(
        plan({
          'Node Type': 'Seq Scan',
          'Relation Name': 'events',
          Alias: 'events',
          Filter: '(tenant_id = 1)',
          'Rows Removed by Filter': 59_999,
          'Actual Rows': 1,
        }),
      );
      assert.equal(rowsRead(scan!), 60_000);
    });
  });

  describe('against a real database', () => {
    let fixture: PostgresFixture;
    let adapter: PostgresAdapter;
    let verifier: Client;

    const QUERY = `SELECT id FROM events WHERE tenant_id = 42 AND kind = 'click'`;

    before(async () => {
      fixture = await startPostgres();
      verifier = new Client({ connectionString: fixture.connectionString });
      await verifier.connect();

      // Big enough that the planner really does prefer an index. The whole
      // feature is meaningless at fixture scale, so the fixture has to grow.
      await verifier.query(`
        CREATE TABLE events (
          id         serial PRIMARY KEY,
          tenant_id  int NOT NULL,
          kind       text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          payload    text
        );
        INSERT INTO events (tenant_id, kind, payload)
        SELECT i % 500, CASE WHEN i % 7 = 0 THEN 'click' ELSE 'view' END, 'x'
        FROM generate_series(1, 60000) AS i;
        ANALYZE events;
      `);

      adapter = new PostgresAdapter();
      await adapter.connect({
        connectionString: fixture.connectionString,
        statementTimeoutMs: 30_000,
        lockTimeoutMs: 5000,
        applicationName: APPLICATION_NAME,
      });
    });

    after(async () => {
      await verifier?.end().catch(() => undefined);
      await adapter?.dispose();
      await fixture?.stop();
    });

    it('finds the sequential scan and names the columns doing the filtering', async () => {
      const plan = await adapter.explain(QUERY, false);
      const candidates = indexCandidates(plan, {
        columnsByTable: new Map([
          ['events', (await adapter.tableColumns('events')).map((column) => column.name)],
        ]),
        // The estimate-only plan has no measured rows, so nothing is filtered
        // out by size here — the candidate has to come from the filter alone.
        minimumRowsRead: 0,
      });

      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]!.table, 'events');
      assert.deepEqual(
        [...candidates[0]!.columns].sort(),
        ['kind', 'tenant_id'],
        'both tested columns, read off a filter string Postgres wrote',
      );
    });

    it('this database cannot do it without building the index', async () => {
      // No hypopg in the embedded build, which is exactly the situation the
      // fallback exists for. If this ever starts returning true the fallback
      // has stopped being exercised and the assertion should move.
      assert.equal(await adapter.supportsHypotheticalIndexes(), false);
    });

    it('refuses to build one unless asked', async () => {
      await assert.rejects(
        () => adapter.testIndex('CREATE INDEX ON events (tenant_id)', QUERY, [], { build: false }),
        HypotheticalIndexUnavailableError,
      );
    });

    it('measures what the index would do', async () => {
      const experiment = await adapter.testIndex(
        'CREATE INDEX ON events (tenant_id, kind)',
        QUERY,
        [],
        { build: true },
      );

      assert.equal(experiment.method, 'built');
      assert.equal(experiment.used, true, 'the planner reached for it');
      assert.ok(
        experiment.afterCost < experiment.beforeCost,
        `cost went ${experiment.beforeCost} -> ${experiment.afterCost}`,
      );
      assert.ok(typeof experiment.beforeMs === 'number');
      assert.ok(typeof experiment.afterMs === 'number');
    });

    it('leaves nothing behind', async () => {
      // The index was built inside a transaction that was rolled back. If any
      // of this escaped, the tool that promises never to write just wrote.
      const { rows } = await verifier.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'events'`,
      );
      assert.deepEqual(
        rows.map((row) => row.indexname),
        ['events_pkey'],
      );
    });

    it('says so when the index would not be used', async () => {
      // An index on a column the query never filters on. The planner ignores
      // it, and reporting that is the point: an index nobody uses still costs
      // write throughput and disk forever.
      const experiment = await adapter.testIndex(
        'CREATE INDEX ON events (created_at)',
        QUERY,
        [],
        { build: true },
      );
      assert.equal(experiment.used, false);
    });

    it('works on a query carrying bound parameters', async () => {
      // The visual editor generates statements with placeholders, and a
      // planner has to be given the values it would really run with.
      const experiment = await adapter.testIndex(
        'CREATE INDEX ON events (tenant_id, kind)',
        `SELECT id FROM events WHERE tenant_id = $1 AND kind = $2`,
        [42, 'click'],
        { build: true },
      );
      assert.equal(experiment.used, true);
    });
  });
});
