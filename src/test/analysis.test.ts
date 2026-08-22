import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { analyzeStatements } from '../analysis/orchestrator';
import { DEFAULT_THRESHOLDS, Finding } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { splitStatements } from '../parser/splitter';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * M1 acceptance: open a file with an UPDATE, get the exact affected count and
 * a sample of the rows as they are and as they would become — with nothing
 * committed.
 *
 * The fixture (see support/pgFixture.ts) has 100 users: 33 on the 'pro' tier,
 * 12 with no email, 8 sharing one email address, 50 with a phone number, 10
 * pointing at an org that does not exist, and a nickname column that is null
 * in every row.
 */

const PRO = 33;
const TOTAL_USERS = 100;

describe('analysis', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
    verifier = new Client({ connectionString: fixture.connectionString });
    await verifier.connect();
  });

  after(async () => {
    await verifier?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  /** Runs a whole file through the orchestrator, in file order. */
  const analyze = async (sql: string): Promise<Finding[]> => {
    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: splitStatements(sql),
      thresholds: DEFAULT_THRESHOLDS,
      onFinding: (finding) => findings.push(finding),
    });
    return findings;
  };

  const one = async (sql: string): Promise<Finding> => {
    const findings = await analyze(sql);
    assert.equal(findings.length, 1, 'expected exactly one statement');
    return findings[0]!;
  };

  const countPro = async (): Promise<number> =>
    Number(
      (await verifier.query(`SELECT COUNT(*)::int AS n FROM users WHERE tier = 'pro'`)).rows[0].n,
    );

  describe('UPDATE', () => {
    it('reports the exact count and a before/after sample', async () => {
      const finding = await one(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`);

      assert.equal(finding.rowCount, PRO);
      // 33 is under the caution threshold of 100, so this is a green row that
      // still shows you exactly what it does. Severity is about blast radius;
      // the sample is available either way.
      assert.equal(finding.severity, 'safe');
      assert.match(finding.detail, /^33 rows in users are updated\.$/);

      const sample = finding.sample!;
      assert.equal(sample.totalAffected, PRO);
      assert.equal(sample.rows.length, DEFAULT_THRESHOLDS.sampleSize);
      assert.equal(sample.unavailable, undefined);

      for (const row of sample.rows) {
        assert.equal(row.before!['tier'], 'pro', 'before shows the old value');
        assert.equal(row.after!['tier'], 'free', 'after shows the new one');
        assert.deepEqual(row.changed, ['tier'], 'and only that column is marked as changed');
        assert.ok(row.key['id'] !== undefined, 'the primary key identifies the record');
      }
    });

    it('commits nothing', async () => {
      assert.equal(await countPro(), PRO);
    });

    it('flags an UPDATE with no WHERE clause as changing everything', async () => {
      const finding = await one(`UPDATE users SET tier = 'free'`);
      assert.equal(finding.rowCount, TOTAL_USERS);
      assert.equal(finding.severity, 'destructive');
      assert.equal(finding.headline, 'Will change every row');
      assert.match(finding.detail, /There is no WHERE clause/);
      assert.equal(await countPro(), PRO);
    });

    it('says so when it rewrites rows without changing their values', async () => {
      // Postgres counts every rewritten row as affected, including rows that
      // already hold the new value. Reporting the count alone would put a
      // large number above a sample of visibly identical rows, which reads as
      // a broken tool rather than as the real finding: a full-table rewrite
      // that costs the same I/O and bloat as a real one.
      const finding = await one(`UPDATE users SET tier = tier WHERE tier IS NOT NULL`);

      assert.equal(finding.rowCount, TOTAL_USERS);
      assert.equal(finding.sample!.changedInSample, 0);

      // Only 20 of the 100 rows were sampled, so the claim is hedged to what
      // was actually observed. Asserting the unhedged wording here would be
      // asserting an overclaim.
      assert.match(finding.detail, /None of the 20 sampled rows actually change value/);
      assert.match(finding.detail, /may be rewriting rows without altering them/);

      for (const row of finding.sample!.rows) {
        assert.deepEqual(row.changed, [], 'no column actually differs');
      }
    });

    it('drops the hedge when the whole affected set was sampled', async () => {
      const finding = await one(
        `UPDATE users SET tier = tier WHERE id <= ${DEFAULT_THRESHOLDS.sampleSize}`,
      );

      assert.equal(finding.rowCount, DEFAULT_THRESHOLDS.sampleSize);
      assert.equal(finding.sample!.changedInSample, 0);
      assert.match(finding.detail, /None of them actually change value/);
    });

    it('does not claim a no-op when values really do change', async () => {
      const finding = await one(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`);
      assert.equal(finding.sample!.changedInSample, DEFAULT_THRESHOLDS.sampleSize);
      assert.doesNotMatch(finding.detail, /without altering/);
    });

    it('says plainly when a statement matches nothing', async () => {
      const finding = await one(`UPDATE users SET tier = 'free' WHERE tier = 'nonexistent'`);
      assert.equal(finding.rowCount, 0);
      assert.equal(finding.severity, 'safe');
      assert.match(finding.detail, /matches no rows/);
    });
  });

  describe('DELETE', () => {
    it('shows the rows as they are, with no after-state', async () => {
      const finding = await one(`DELETE FROM users WHERE tier = 'pro'`);
      assert.equal(finding.rowCount, PRO);

      const row = finding.sample!.rows[0]!;
      assert.ok(row.before, 'the row that would be deleted is shown');
      assert.equal(row.after, null, 'and it has no after-state');
      assert.equal(await countPro(), PRO, 'nothing was actually deleted');
    });

    it('treats a missing WHERE as its own kind of mistake', async () => {
      const finding = await one(`DELETE FROM users`);
      assert.equal(finding.rowCount, TOTAL_USERS);
      assert.equal(finding.severity, 'destructive');
      assert.match(finding.detail, /Deletes every row/);
    });
  });

  describe('INSERT', () => {
    it('shows the new row with no before-state', async () => {
      const finding = await one(
        `INSERT INTO users (email, tier) VALUES ('brand-new@example.com', 'pro')`,
      );
      assert.equal(finding.rowCount, 1);

      const row = finding.sample!.rows[0]!;
      assert.equal(row.before, null);
      assert.equal(row.after!['email'], 'brand-new@example.com');
    });
  });

  describe('blast radius', () => {
    it('reports the table size alongside the affected count', async () => {
      // Without the total, "33 rows" carries no weight — the panel cannot draw
      // it to scale and the reader cannot tell a rounding error from a
      // catastrophe.
      const finding = await one(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`);
      assert.equal(finding.rowCount, PRO);
      assert.equal(finding.tableRows, TOTAL_USERS);
    });

    it('reports it for DDL too', async () => {
      const finding = await one(`ALTER TABLE users DROP COLUMN phone_number`);
      assert.equal(finding.rowCount, 50);
      assert.equal(finding.tableRows, TOTAL_USERS);
    });

    it('does not read a never-analysed table as an empty one', async () => {
      // Postgres reports reltuples = -1 until a table has been analysed. Taking
      // that as zero would size every warning against an empty table — and the
      // freshly-loaded table that has never been analysed is exactly the one
      // most likely to be huge.
      await verifier.query(`CREATE TABLE never_analysed AS SELECT i FROM generate_series(1, 500) i`);
      try {
        const { rows } = await verifier.query(
          `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass('never_analysed')`,
        );
        assert.equal(Number(rows[0].n), -1, 'precondition: the catalog says "unknown"');

        const stats = await adapter.tableStats('never_analysed');
        assert.equal(stats.estimatedRows, 500, 'falls back to counting rather than reporting zero');
      } finally {
        await verifier.query('DROP TABLE never_analysed');
      }
    });

    it('looks the table up once however many statements hit it', async () => {
      // Each lookup is a network round trip, and a migration touches the same
      // few tables over and over.
      const findings = await analyze(`
        UPDATE users SET tier = 'free' WHERE tier = 'pro';
        DELETE FROM users WHERE tier = 'pro';
        ALTER TABLE users DROP COLUMN nickname;
      `);
      assert.deepEqual(
        findings.map((f) => f.tableRows),
        [TOTAL_USERS, TOTAL_USERS, TOTAL_USERS],
      );
    });
  });

  describe('DDL probes', () => {
    it('counts the rows a DROP COLUMN would empty', async () => {
      const finding = await one(`ALTER TABLE users DROP COLUMN phone_number`);
      assert.equal(finding.severity, 'destructive');
      assert.equal(finding.rowCount, 50);
      assert.match(finding.detail, /^50 rows have a value in phone_number/);
    });

    it('calls a DROP COLUMN safe when the column is empty', async () => {
      const finding = await one(`ALTER TABLE users DROP COLUMN nickname`);
      assert.equal(finding.severity, 'safe');
      assert.equal(finding.headline, 'Safe');
      assert.match(finding.detail, /empty in all 100 rows/);
    });

    it('counts the rows that would make SET NOT NULL fail', async () => {
      const finding = await one(`ALTER TABLE users ALTER COLUMN email SET NOT NULL`);
      assert.equal(finding.severity, 'blocking');
      assert.equal(finding.rowCount, 12);
      assert.match(finding.detail, /stops here, partway applied/);
    });

    it('finds duplicates that would break a unique constraint', async () => {
      const finding = await one(`ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)`);
      assert.equal(finding.severity, 'blocking');
      assert.equal(finding.rowCount, 8);
      assert.match(finding.detail, /8 rows share a duplicate email, across 1 value/);
    });

    it('finds orphans that would break a foreign key', async () => {
      const finding = await one(
        `ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)`,
      );
      assert.equal(finding.severity, 'blocking');
      assert.equal(finding.rowCount, 10);
      assert.match(finding.detail, /reference org_id values that are not in orgs/);
    });

    it('counts rows violating a CHECK', async () => {
      const finding = await one(`ALTER TABLE users ADD CONSTRAINT tier_len CHECK (length(tier) > 4)`);
      assert.equal(finding.severity, 'blocking');
      assert.ok(finding.rowCount! > 0);
    });

    it('marks index build time as an estimate and points at CONCURRENTLY', async () => {
      const finding = await one(`CREATE INDEX idx_users_tier ON users (tier)`);
      assert.equal(finding.estimated, true);
      assert.match(finding.detail, /Adding CONCURRENTLY avoids the lock/);
    });

    it('calls a CONCURRENTLY build safe', async () => {
      const finding = await one(`CREATE INDEX CONCURRENTLY idx_users_tier2 ON users (tier)`);
      assert.equal(finding.severity, 'safe');
    });

    it('never executes DDL, even the safe-looking kind', async () => {
      await one(`ALTER TABLE users ADD COLUMN definitely_not_added text`);
      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'definitely_not_added'`,
      );
      assert.equal(Number(rows[0].n), 0, 'the column must not exist');
    });
  });

  describe('a whole file', () => {
    it('resolves every statement, and an error on one row does not stop the rest', async () => {
      const findings = await analyze(`
        UPDATE users SET tier = 'free' WHERE tier = 'pro';
        DELETE FROM nonexistent_table;
        ALTER TABLE users DROP COLUMN nickname;
      `);

      assert.equal(findings.length, 3);
      assert.equal(findings[0]!.rowCount, PRO);
      assert.equal(findings[1]!.headline, "Couldn't analyze");
      assert.match(findings[1]!.detail, /previews never commit/);
      assert.equal(findings[2]!.severity, 'safe');
    });

    it('leaves the database exactly as it found it', async () => {
      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE tier = 'pro')::int AS pro,
                COUNT(*) FILTER (WHERE email IS NULL)::int AS null_emails,
                COUNT(phone_number)::int AS phones
           FROM users`,
      );
      assert.deepEqual(
        { ...rows[0] },
        { total: TOTAL_USERS, pro: PRO, null_emails: 12, phones: 50 },
      );
    });
  });
});
