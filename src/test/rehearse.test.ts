import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { REHEARSAL_SCHEMA } from '../adapters/postgresRehearsal';
import { planRehearsal, rehearsalReport } from '../analysis/rehearse';
import { languageFor } from '../parser/language';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Rehearsing a migration on copies of its tables.
 *
 * The one part of Rehearsal that runs a schema change for real, so the checks
 * are as much about what it must not do — touch an original, leave a copy
 * behind — as about the timings it exists to produce.
 */
describe('rehearsing on a copy', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let client: Client;

  const MIGRATION = [
    'ALTER TABLE users ALTER COLUMN tier TYPE varchar(10);',
    'CREATE INDEX idx_users_email ON users (email);',
    "UPDATE public.users SET tier = 'x';",
    'ALTER TABLE users ALTER COLUMN email SET NOT NULL;',
    'ALTER TABLE users ADD COLUMN never_added int;',
  ].join('\n');

  before(async () => {
    fixture = await startPostgres();
    client = new Client({ connectionString: fixture.connectionString });
    await client.connect();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 5000,
      applicationName: 'vscode-rehearsal',
    });
  });

  after(async () => {
    await adapter.dispose().catch(() => undefined);
    await client.end().catch(() => undefined);
    await fixture.stop();
  });

  it('runs each statement for real, times it, and stops where the migration would', async () => {
    const language = languageFor('postgres');
    const statements = language.split(MIGRATION);
    const plan = planRehearsal(statements, language, await adapter.schemaSnapshot());

    assert.deepEqual(plan.tables, ['users']);

    const rehearsal = await adapter.rehearseOnCopy(plan);
    const status = rehearsal.statements.map((statement) => statement.status);

    assert.deepEqual(status, ['ran', 'ran', 'skipped', 'failed', 'not reached']);
    assert.ok(typeof rehearsal.statements[0]!.milliseconds === 'number');
    assert.match(String(rehearsal.statements[2]!.reason), /names a schema explicitly/);
    assert.match(String(rehearsal.statements[3]!.error), /contains null values/);
    assert.equal(rehearsal.copied[0]!.rows, 100);

    const report = rehearsalReport(rehearsal, statements, { file: 'm.sql', connection: 'test' });
    assert.match(report, /It stops at line 4/);

    // The fixture has no pg_stat_statements, so the queries section says why
    // it is absent rather than being silently empty.
    if (!rehearsal.queries) {
      assert.match(String(rehearsal.queriesSkipped), /pg_stat_statements|Postgres 16/);
      assert.match(report, /Queries were not planned/);
    }
  });

  it('leaves the originals exactly as they were, and no copy behind', async () => {
    const tier = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'tier'`,
    );
    assert.equal(tier.rows[0]?.data_type, 'text', 'the real column was retyped');

    const index = await client.query(`SELECT to_regclass('public.idx_users_email') AS found`);
    assert.equal(index.rows[0]?.found, null, 'the index was built on the real table');

    const schema = await client.query(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
      [REHEARSAL_SCHEMA],
    );
    assert.equal(schema.rows[0]?.n, 0, 'the copy outlived its transaction');

    const tiers = await client.query(`SELECT count(*)::int AS n FROM users WHERE tier = 'x'`);
    assert.equal(tiers.rows[0]?.n, 0);
  });
});

describe('who would have waited behind each lock', () => {
  it('multiplies the real lock time by how often the table is queried', () => {
    const statements = languageFor('postgres').split(
      'ALTER TABLE orders ALTER COLUMN total TYPE bigint;\nCREATE INDEX idx_o ON orders (status);',
    );

    const report = rehearsalReport(
      {
        ran: true,
        copied: [{ table: 'orders', rows: 300_000 }],
        copyMilliseconds: 900,
        statements: [
          { index: 0, status: 'ran', milliseconds: 2000 },
          { index: 1, status: 'ran', milliseconds: 1000 },
        ],
        traffic: [{ table: 'orders', readsPerSecond: 40, writesPerSecond: 10, windowSeconds: 7200 }],
      },
      statements,
      { file: 'm.sql', connection: 'test' },
    );

    // ACCESS EXCLUSIVE blocks reads and writes: (40 + 10) a second for 2s.
    assert.match(report, /\| 1 \| ACCESS EXCLUSIVE on orders \| 2\.0s \| reads and writes \| about 100 \|/);
    // A plain index build takes SHARE, which lets reads through: 10 a second for 1s.
    assert.match(report, /\| 2 \| SHARE on orders \| 1\.0s \| writes \| about 10 \|/);
    assert.match(report, /averaged over the last 2 hours/);
  });
});
