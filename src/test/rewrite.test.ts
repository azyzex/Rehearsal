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
 * Safer rewrites.
 *
 * The tests that matter here are not that the strings are produced — it is
 * that the SQL they produce actually runs, and that it is offered only when
 * the measurement says it is needed. A three-step dance suggested for a
 * statement that would have applied cleanly is the cargo-cult version of the
 * advice, and it trains people to ignore the suggestions that matter.
 */

describe('rewrites', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 15_000,
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

  const analyse = async (sql: string): Promise<Finding> => {
    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: splitStatements(sql),
      thresholds: DEFAULT_THRESHOLDS,
      onFinding: (finding) => findings.push(finding),
    });
    return findings[0]!;
  };

  describe('what is offered', () => {
    it('offers CONCURRENTLY for a plain index build', async () => {
      const finding = await analyse('CREATE INDEX idx_users_tier ON users (tier)');
      const rewrite = finding.rewrites![0]!;

      assert.match(rewrite.title, /without locking/);
      assert.match(rewrite.statements[0]!, /CREATE INDEX CONCURRENTLY/);
      assert.equal(rewrite.needsSeparateTransactions, true, 'and says so, because it matters');
    });

    it('offers nothing for an index already built concurrently', async () => {
      // Suggesting a fix for something already correct is how a tool teaches
      // people to stop reading it.
      const finding = await analyse('CREATE INDEX CONCURRENTLY idx_x ON users (tier)');
      assert.equal(finding.rewrites, undefined);
    });

    it('offers the three-step NOT NULL, and the backfill it needs first', async () => {
      const finding = await analyse('ALTER TABLE users ALTER COLUMN email SET NOT NULL');

      // 12 rows have no email, so no rewrite makes this apply as it stands.
      const backfill = finding.rewrites!.find((r) => r.title.includes('Backfill'))!;
      assert.match(backfill.title, /12 null rows/);
      assert.match(backfill.statements[0]!, /UPDATE users SET email =.*WHERE email IS NULL/);

      const safe = finding.rewrites!.find((r) => r.title.includes('without holding'))!;
      assert.match(safe.statements[0]!, /CHECK \(email IS NOT NULL\) NOT VALID/);
      assert.match(safe.statements[1]!, /VALIDATE CONSTRAINT/);
      assert.match(safe.statements[2]!, /SET NOT NULL/);
    });

    it('does not offer a backfill when there is nothing to backfill', async () => {
      const finding = await analyse('ALTER TABLE users ALTER COLUMN tier SET NOT NULL');
      assert.equal(
        finding.rewrites!.some((r) => r.title.includes('Backfill')),
        false,
        'tier is already NOT NULL in every row',
      );
      // The lock-free form is still worth offering: the scan is the cost, and
      // it happens whether or not anything violates.
      assert.ok(finding.rewrites!.some((r) => r.title.includes('without holding')));
    });

    it('offers NOT VALID for a check and a foreign key', async () => {
      const check = await analyse(
        'ALTER TABLE users ADD CONSTRAINT tier_len CHECK (length(tier) > 2)',
      );
      assert.match(check.rewrites![0]!.statements[0]!, /CHECK \(length\(tier\) > 2\) NOT VALID/);
      assert.match(check.rewrites![0]!.statements[1]!, /VALIDATE CONSTRAINT/);

      const fk = await analyse(
        'ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)',
      );
      assert.match(fk.rewrites![0]!.statements[0]!, /FOREIGN KEY \(org_id\) REFERENCES orgs \(id\) NOT VALID/);
    });

    it('mentions the violations that no rewrite can fix', async () => {
      // 10 users point at an org that does not exist. The safe form is still
      // the right shape, and it still fails until those are dealt with.
      const finding = await analyse(
        'ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)',
      );
      assert.match(finding.rewrites![0]!.rationale, /still fails on the 10 existing rows/);
    });

    it('offers the concurrent index route for a unique constraint', async () => {
      const finding = await analyse('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)');
      const rewrite = finding.rewrites![0]!;

      assert.match(rewrite.statements[0]!, /CREATE UNIQUE INDEX CONCURRENTLY/);
      assert.match(rewrite.statements[1]!, /UNIQUE USING INDEX/);
      assert.match(rewrite.rationale, /8 rows share a value/);
    });

    it('offers nothing for statements where there is nothing safer to say', async () => {
      assert.equal((await analyse('ALTER TABLE users DROP COLUMN nickname')).rewrites, undefined);
      assert.equal((await analyse(`UPDATE users SET tier = 'free'`)).rewrites, undefined);
      assert.equal((await analyse('DROP TABLE orgs')).rewrites, undefined);
    });
  });

  describe('the SQL actually runs', () => {
    /**
     * The point of these: a rewrite is advice this tool gives with some
     * confidence, and advice that does not parse is worse than none.
     */
    const runRewrite = async (statements: readonly string[]): Promise<void> => {
      for (const statement of statements) {
        await verifier.query(statement);
      }
    };

    it('the concurrent index build works', async () => {
      const finding = await analyse('CREATE INDEX idx_users_tier ON users (tier)');
      await runRewrite(finding.rewrites![0]!.statements);

      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE tablename = 'users' AND indexname LIKE 'idx_users_tier%'`,
      );
      assert.ok(Number(rows[0].n) >= 1, 'the index exists');
    });

    it('the three-step NOT NULL works end to end', async () => {
      // Backfill first, because the whole point is that the rewrite does not
      // remove the need to deal with the offending rows.
      // Distinct values: these tests commit, and filling every null with the same
      // string would leave twelve duplicates for the unique test below.
      await verifier.query(`UPDATE users SET email = 'backfilled-' || id WHERE email IS NULL`);

      const finding = await analyse('ALTER TABLE users ALTER COLUMN email SET NOT NULL');
      const safe = finding.rewrites!.find((r) => r.title.includes('without holding'))!;
      await runRewrite(safe.statements);

      const { rows } = await verifier.query(
        `SELECT attnotnull FROM pg_attribute
          WHERE attrelid = 'users'::regclass AND attname = 'email'`,
      );
      assert.equal(rows[0].attnotnull, true, 'the column really is NOT NULL now');

      // And the scaffolding is gone.
      const constraints = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname LIKE 'users_email_not_null'`,
      );
      assert.equal(Number(constraints.rows[0].n), 0, 'the helper constraint was dropped');
    });

    it('the NOT VALID foreign key works once the orphans are gone', async () => {
      await verifier.query(`UPDATE users SET org_id = 1 WHERE org_id NOT IN (SELECT id FROM orgs)`);

      const finding = await analyse(
        'ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)',
      );
      await runRewrite(finding.rewrites![0]!.statements);

      const { rows } = await verifier.query(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'users_org_id_fkey'`,
      );
      assert.equal(rows[0]?.convalidated, true, 'added and then validated');
    });

    it('the unique-via-index route works once the duplicates are gone', async () => {
      await verifier.query(
        `UPDATE users SET email = 'unique-' || id WHERE email = 'dupe@example.com'`,
      );

      const finding = await analyse('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)');
      await runRewrite(finding.rewrites![0]!.statements);

      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM pg_constraint
          WHERE conrelid = 'users'::regclass AND contype = 'u'`,
      );
      assert.ok(Number(rows[0].n) >= 1, 'the unique constraint exists');
    });
  });
});
