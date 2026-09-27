import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { analyzeStatements } from '../analysis/orchestrator';
import { analyzeDml } from '../analysis/dml';
import { Finding } from '../analysis/types';
import { languageFor } from '../parser/language';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * An index on a partitioned table.
 *
 * The usual advice — add CONCURRENTLY — is an error on a partitioned parent,
 * so Rehearsal was handing people a statement that does not run. This checks
 * the replacement advice the only way that proves it: by running it.
 */
describe('a partitioned table', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let client: Client;

  before(async () => {
    fixture = await startPostgres();
    client = new Client({ connectionString: fixture.connectionString });
    await client.connect();
    await client.query(`
      CREATE TABLE events (id bigint, happened date NOT NULL, kind text)
        PARTITION BY RANGE (happened);
      CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
      CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      INSERT INTO events SELECT i, DATE '2025-06-01' + (i % 400), 'k' || (i % 5)
        FROM generate_series(1, 2000) i;
      ANALYZE events;
    `);

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

  it('measures the WAL a write produces, inside the rolled-back run', async () => {
    // WAL is written as a statement runs, commit or not, so the preview can
    // read exactly what the migration would ship to every replica.
    const sql = "UPDATE events SET kind = 'rewritten'";
    const result = await analyzeDml(
      adapter,
      sql,
      languageFor('postgres').classify(sql),
      { cautionRows: 100, destructiveRows: 1000, largeTable: 100_000, sampleSize: 3 },
      [],
    );

    assert.equal(result.rowCount, 2000);
    assert.ok((result.walBytes ?? 0) > 0, `no WAL measured: ${result.walBytes}`);

    const after = await client.query("SELECT count(*)::int AS n FROM events WHERE kind = 'rewritten'");
    assert.equal(after.rows[0]?.n, 0, 'the update was not rolled back');
  });

  it('says the change reaches every partition, and offers a sequence that runs', async () => {
    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: languageFor('postgres').split('CREATE INDEX idx_kind ON events (kind);'),
      thresholds: { cautionRows: 100, destructiveRows: 1000, largeTable: 100_000, sampleSize: 3 },
      onFinding: (finding) => findings.push(finding),
    });

    const finding = findings[0]!;
    assert.equal(finding.partitioning?.kind, 'partitioned');
    assert.equal(finding.partitioning?.count, 2);
    assert.match(finding.detail, /each of its 2 partitions/);

    const rewrite = finding.rewrites?.[0];
    assert.ok(rewrite, 'no rewrite offered');
    assert.match(rewrite.statements[0]!, /ON ONLY events/);
    assert.ok(
      !rewrite.statements.some((sql) => /CONCURRENTLY idx_\w+ ON events \(/.test(sql)),
      'it still offered CONCURRENTLY on the parent',
    );

    // And it runs. Each statement on its own, outside a transaction, which is
    // what CONCURRENTLY needs.
    for (const sql of rewrite.statements) {
      await client.query(sql);
    }
    const valid = await client.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_events_kind'::regclass`,
    );
    assert.equal(valid.rows[0]?.indisvalid, true, 'the parent index never became valid');
  });
});
