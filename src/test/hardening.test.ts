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
 * Spec §10, the safety rules, tested rather than asserted.
 *
 * Each of these was implemented early and believed ever since. Believing a
 * guard works is not the same as knowing it does, and these are the guards the
 * entire pitch rests on — "it cannot hurt your database" is either true under
 * adversarial conditions or it is marketing.
 */

describe('safety under load', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 1000,
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

  describe('lock timeout (§10.2)', () => {
    it('gives up rather than joining a lock queue', async () => {
      // Someone else holds an exclusive lock on users. A preview that waited
      // would sit behind them — and worse, would itself block every writer
      // queueing behind it. The whole point is that a preview is never the
      // reason a queue forms.
      const blocker = new Client({ connectionString: fixture.connectionString });
      await blocker.connect();

      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');

        const started = Date.now();
        await assert.rejects(
          adapter.withRollback(async (tx) => {
            await tx.query(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`);
          }),
          /lock timeout|canceling statement/i,
        );

        const waited = Date.now() - started;
        assert.ok(waited < 4000, `gave up after ${waited}ms rather than waiting indefinitely`);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end().catch(() => undefined);
      }
    });

    it('is usable again as soon as the lock clears', async () => {
      const rowCount = await adapter.withRollback(async (tx) => {
        const result = await tx.query(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`);
        return result.rowCount;
      });
      assert.equal(rowCount, 33);
    });
  });

  describe('cancellation (§10.9)', () => {
    it('stops partway through a file and leaves nothing behind', async () => {
      const sql = `
        UPDATE users SET tier = 'a' WHERE id = 1;
        UPDATE users SET tier = 'b' WHERE id = 2;
        UPDATE users SET tier = 'c' WHERE id = 3;
        UPDATE users SET tier = 'd' WHERE id = 4;
      `;

      const findings: Finding[] = [];
      let cancelled = false;

      await analyzeStatements({
        adapter,
        statements: splitStatements(sql),
        thresholds: DEFAULT_THRESHOLDS,
        isCancelled: () => cancelled,
        onFinding: (finding) => {
          findings.push(finding);
          // Stop after the first result, the way pressing the button does.
          cancelled = true;
        },
      });

      assert.equal(findings.length, 1, 'the remaining statements were never run');

      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE tier IN ('a','b','c','d')`,
      );
      assert.equal(Number(rows[0].n), 0, 'and nothing was left behind');
    });

    it('does no work at all when cancelled before it starts', async () => {
      const findings: Finding[] = [];
      await analyzeStatements({
        adapter,
        statements: splitStatements(`DELETE FROM users;`),
        thresholds: DEFAULT_THRESHOLDS,
        isCancelled: () => true,
        onFinding: (finding) => findings.push(finding),
      });
      assert.deepEqual(findings, []);
    });
  });

  describe('never executing what it only means to measure', () => {
    it('refuses EXPLAIN ANALYZE outside a rolled-back transaction (§6.2)', async () => {
      // ANALYZE really runs the statement. Offering it on a path that does not
      // roll back would be a delete dressed as a measurement.
      await assert.rejects(
        adapter.explain(`DELETE FROM users`, true),
        /executes the statement for real/,
      );

      const { rows } = await verifier.query('SELECT COUNT(*)::int AS n FROM users');
      assert.equal(Number(rows[0].n), 100);
    });

    it('plans without analysing quite happily', async () => {
      const plan = await adapter.explain(`SELECT * FROM users WHERE tier = 'pro'`, false);
      assert.ok(plan.raw, 'a plan came back');
    });

    it('plans a statement that carries bound parameters', async () => {
      // Every statement the visual editor generates has them, so a planner
      // that could not be given values would be useless for exactly the
      // statements most worth planning.
      const plan = await adapter.explain('SELECT * FROM users WHERE tier = $1', false, ['pro']);
      assert.ok(plan.raw);
    });
  });

  describe('the single connection (§10.8)', () => {
    it('refuses a second connection on the same adapter', async () => {
      await assert.rejects(
        adapter.connect({
          connectionString: fixture.connectionString,
          statementTimeoutMs: 1000,
          lockTimeoutMs: 1000,
          applicationName: APPLICATION_NAME,
        }),
        /Already connected/,
      );
    });

    it('holds exactly one session open', async () => {
      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`,
        [APPLICATION_NAME],
      );
      assert.equal(Number(rows[0].n), 1);
    });

    it('leaves no session behind after disposal', async () => {
      const temporary = new PostgresAdapter();
      await temporary.connect({
        connectionString: fixture.connectionString,
        statementTimeoutMs: 1000,
        lockTimeoutMs: 1000,
        applicationName: 'vscode-dryrun-temporary',
      });
      await temporary.dispose();

      // The server takes a moment to reap a closed backend.
      let remaining = 1;
      for (let attempt = 0; attempt < 20 && remaining > 0; attempt++) {
        const { rows } = await verifier.query(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`,
          ['vscode-dryrun-temporary'],
        );
        remaining = Number(rows[0].n);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(remaining, 0);
    });
  });

  describe('an analysis that throws does not poison the connection', () => {
    it('recovers from a failed statement and keeps measuring', async () => {
      const findings: Finding[] = [];
      await analyzeStatements({
        adapter,
        statements: splitStatements(`
          DELETE FROM table_that_does_not_exist;
          UPDATE users SET tier = 'free' WHERE tier = 'pro';
        `),
        thresholds: DEFAULT_THRESHOLDS,
        onFinding: (finding) => findings.push(finding),
      });

      assert.equal(findings.length, 2);
      assert.equal(findings[0]!.headline, "Couldn't analyze");
      assert.equal(findings[1]!.rowCount, 33, 'the next statement still measured correctly');
    });
  });
});
