import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MysqlAdapter } from '../adapters/mysql';
import {
  CLONE_PREFIX,
  canClone,
  measureOnClone,
  sweepStaleClones,
} from '../adapters/mysqlClone';
import { analyzeStatements } from '../analysis/orchestrator';
import { Finding } from '../analysis/types';
import { languageFor } from '../parser/language';
import { MysqlFixture, seedMysql, startMysql } from './support/mysqlFixture';

/**
 * Measuring a MySQL schema change by running it against a copy.
 *
 * The counting probes answer "88 rows cannot convert". The server answers
 * "Incorrect integer value: 'user21@example.com' for column 'email' at row 13",
 * which names the value and is the sentence someone can act on.
 *
 * This is also the one part of the project that writes, so half of what is
 * checked here is that it writes only where it is allowed to: never the
 * original, always cleaned up, and not at all when the statement's target
 * cannot be identified beyond doubt.
 */

describe('measuring a MySQL change against a copy', () => {
  let fixture: MysqlFixture;
  let adapter: MysqlAdapter;

  /** Every table in the database right now. */
  async function tables(): Promise<string[]> {
    const connection = await fixture.connect();
    try {
      const [rows] = await connection.query(
        'SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
      );
      return (rows as { n: string }[]).map((row) => String(row.n));
    } finally {
      await connection.end();
    }
  }

  before(async () => {
    fixture = await startMysql();
    const connection = await fixture.connect();
    try {
      await seedMysql(connection);
    } finally {
      await connection.end();
    }

    adapter = new MysqlAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5000,
      applicationName: 'vscode-dryrun',
    });
  });

  after(async () => {
    await adapter.dispose().catch(() => undefined);
    await fixture.stop();
  });

  it('knows whether it may create a table at all', async () => {
    // Pointed at a read-only role this is false, and the count stays the
    // answer rather than a failed statement mid-preview.
    assert.equal(await canClone(adapter), true, 'root should be able to');
  });

  it('reports the real error, with the value that caused it', async () => {
    // The whole point. A probe can say how many rows will not convert; only
    // the server can say which value it choked on.
    const result = await measureOnClone(
      adapter,
      'users',
      'ALTER TABLE users MODIFY email INT NOT NULL',
    );

    assert.equal(result.ran, true, result.skipped);
    assert.equal(result.succeeded, false, 'that ALTER cannot succeed against this data');
    assert.match(String(result.error), /Incorrect integer value|Data truncated/i);
    assert.match(String(result.error), /email/);
  });

  it('reports a change that really does work as working', async () => {
    // The half that has to stay true: a probe that says everything fails is as
    // useless as one that says nothing does.
    const result = await measureOnClone(
      adapter,
      'users',
      'ALTER TABLE users MODIFY nickname VARCHAR(80) NULL',
    );

    assert.equal(result.ran, true, result.skipped);
    assert.equal(result.succeeded, true, result.error);
    assert.equal(result.rows, 100);
    assert.ok(typeof result.milliseconds === 'number', 'and says how long it took');
  });

  it('runs an index build against the copy too', async () => {
    const result = await measureOnClone(
      adapter,
      'users',
      'CREATE INDEX by_org ON users (org_id)',
    );

    assert.equal(result.ran, true, result.skipped);
    assert.equal(result.succeeded, true, result.error);
  });

  it('reports a unique index that the data will not allow', async () => {
    // Eight rows share dupe@example.com.
    const result = await measureOnClone(
      adapter,
      'users',
      'CREATE UNIQUE INDEX one_email ON users (email)',
    );

    assert.equal(result.ran, true, result.skipped);
    assert.equal(result.succeeded, false);
    assert.match(String(result.error), /Duplicate entry/i);
    assert.match(String(result.error), /dupe@example\.com/);

    // And it names the table the reader has, not the copy. MySQL reports the
    // table it was really working on, which is an implementation detail in the
    // one sentence here that is meant to be the clearest.
    assert.doesNotMatch(String(result.error), new RegExp(CLONE_PREFIX));
    assert.match(String(result.error), /users/);
  });

  describe('what it refuses to do', () => {
    it('leaves the original table exactly as it was', async () => {
      // Everything above ran an ALTER that would have changed `users`. The
      // column it targeted is still what it was.
      const connection = await fixture.connect();
      try {
        const [columns] = await connection.query(
          `SELECT DATA_TYPE AS t FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'`,
        );
        assert.equal((columns as { t: string }[])[0]!.t, 'varchar', 'the original was altered');

        const [rows] = await connection.query('SELECT COUNT(*) AS n FROM users');
        assert.equal(Number((rows as { n: number }[])[0]!.n), 100);
      } finally {
        await connection.end();
      }
    });

    it('drops every copy it made', async () => {
      const left = (await tables()).filter((name) => name.startsWith(CLONE_PREFIX));
      assert.deepEqual(left, [], 'a copy was left behind');
    });

    it('will not run a statement whose target it cannot identify', async () => {
      // Guessing here would mean running an ALTER against a real table, which
      // is the one outcome this module exists to make impossible.
      const result = await measureOnClone(
        adapter,
        'users',
        'RENAME TABLE users TO people',
      );

      assert.equal(result.ran, false);
      assert.match(String(result.skipped), /could not be certain/i);
    });

    it('will not run a statement that names a different table', async () => {
      // The classifier says `users` and the SQL says `orgs`: something is
      // wrong, and copying either one would be a guess.
      const result = await measureOnClone(
        adapter,
        'users',
        'ALTER TABLE orgs MODIFY name VARCHAR(10)',
      );

      assert.equal(result.ran, false);
      assert.match(String(result.skipped), /could not be certain/i);
    });

    it('stops at the row ceiling rather than copying something large', async () => {
      const result = await measureOnClone(
        adapter,
        'users',
        'ALTER TABLE users MODIFY nickname VARCHAR(90)',
        { rowCeiling: 10 },
      );

      assert.equal(result.ran, false);
      assert.match(String(result.skipped), /100 rows, over the 10 limit/);
    });

    it('refuses to copy a copy', async () => {
      const result = await measureOnClone(
        adapter,
        `${CLONE_PREFIX}abc_users`,
        `ALTER TABLE ${CLONE_PREFIX}abc_users MODIFY x INT`,
      );

      assert.equal(result.ran, false);
      assert.match(String(result.skipped), /already a Dry Run copy/);
    });
  });

  describe('the sweep', () => {
    it('drops a copy an earlier run left behind', async () => {
      const orphan = `${CLONE_PREFIX}stale_users`;
      const connection = await fixture.connect();
      try {
        await connection.query(`CREATE TABLE \`${orphan}\` (id INT)`);
      } finally {
        await connection.end();
      }

      assert.ok((await tables()).includes(orphan), 'the orphan was not created');

      // Age zero, so everything counts as stale.
      const dropped = await sweepStaleClones(adapter, 0);

      assert.ok(dropped.includes(orphan), `dropped ${dropped.join(', ') || 'nothing'}`);
      assert.ok(!(await tables()).includes(orphan));
    });

    it('leaves a copy young enough to belong to a run in progress', async () => {
      // Two windows previewing at once must not delete each other's working
      // copies.
      const fresh = `${CLONE_PREFIX}fresh_users`;
      const connection = await fixture.connect();
      try {
        await connection.query(`CREATE TABLE \`${fresh}\` (id INT)`);
      } finally {
        await connection.end();
      }

      const dropped = await sweepStaleClones(adapter, 60 * 60 * 1000);
      assert.ok(!dropped.includes(fresh), 'a copy in use was dropped');
      assert.ok((await tables()).includes(fresh));

      await sweepStaleClones(adapter, 0);
    });

    it('touches nothing that is not a copy', async () => {
      await sweepStaleClones(adapter, 0);

      const remaining = await tables();
      assert.ok(remaining.includes('users'), 'the sweep dropped a real table');
      assert.ok(remaining.includes('orgs'));
    });
  });
});

/**
 * The copy folded into the finding the panel shows.
 *
 * Only ever in one direction: a copy that *fails* is definitive and takes over,
 * and a copy that *succeeds* adds a sentence without softening anything. The
 * asymmetry is not caution for its own sake — `CREATE TABLE … LIKE` does not
 * copy foreign keys, so a statement whose real failure would be a foreign key
 * failure succeeds against the copy, and letting that downgrade a blocking
 * finding would turn exactly that case green.
 */
describe('what the panel is told, with and without a copy', () => {
  let fixture: MysqlFixture;
  let adapter: MysqlAdapter;

  const base = {
    cautionRows: 100,
    destructiveRows: 1000,
    largeTable: 100_000,
    sampleSize: 3,
    explainAnalyze: false,
  };

  async function findingsFor(sql: string, cloneTables: boolean): Promise<Finding[]> {
    const language = languageFor('mysql');
    const statements = language.split(sql).map((statement, index) => ({ ...statement, index }));
    const findings: Finding[] = [];

    await analyzeStatements({
      adapter,
      statements,
      thresholds: { ...base, cloneTables, cloneRowLimit: 500_000 },
      onFinding: (finding) => findings.push(finding),
      isCancelled: () => false,
    });

    return findings;
  }

  before(async () => {
    fixture = await startMysql();
    const connection = await fixture.connect();
    try {
      await seedMysql(connection);
    } finally {
      await connection.end();
    }

    adapter = new MysqlAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5000,
      applicationName: 'vscode-dryrun',
    });
  });

  after(async () => {
    await adapter.dispose().catch(() => undefined);
    await fixture.stop();
  });

  it('changes nothing when it is off, which is the default', async () => {
    const [finding] = await findingsFor('ALTER TABLE users MODIFY email INT NOT NULL;', false);

    assert.equal(finding!.severity, 'blocking');
    assert.match(finding!.detail, /12 rows have no email/);
    assert.doesNotMatch(finding!.detail, /copy/i, 'it copied a table without being asked');
  });

  it('adds the server own words to a counted failure', async () => {
    const [finding] = await findingsFor('ALTER TABLE users MODIFY email INT NOT NULL;', true);

    assert.equal(finding!.severity, 'blocking');
    assert.match(finding!.detail, /12 rows have no email/, 'the count is still there');
    assert.match(finding!.detail, /Run against a copy/);
    assert.match(finding!.detail, /Data truncated|Incorrect integer value/i);
  });

  it('catches a failure the counting missed entirely', async () => {
    // This is the case that justifies the whole technique. Counted, a unique
    // index reads as "locks the table briefly". Run against a copy, MySQL
    // refuses it outright — eight rows share an email.
    const sql = 'CREATE UNIQUE INDEX one_email ON users (email);';

    const [counted] = await findingsFor(sql, false);
    assert.notEqual(counted!.severity, 'blocking', 'counting already caught this');

    const [copied] = await findingsFor(sql, true);
    assert.equal(copied!.severity, 'blocking');
    assert.match(copied!.detail, /Duplicate entry/i);
    assert.match(copied!.detail, /dupe@example\.com/);
  });

  it('confirms a change that works, and says how long it took', async () => {
    const [finding] = await findingsFor(
      'ALTER TABLE users MODIFY nickname VARCHAR(90) NULL;',
      true,
    );

    assert.equal(finding!.severity, 'safe');
    assert.match(finding!.detail, /Run against a copy of all 100 rows, it succeeded/);
    assert.match(finding!.detail, /\d+ms/);
  });

  it('leaves no copy behind, and no mark on the original', async () => {
    const connection = await fixture.connect();
    try {
      const [left] = await connection.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '${CLONE_PREFIX.replace(/_/g, '\\_')}%'`,
      );
      assert.equal(Number((left as { n: number }[])[0]!.n), 0, 'a copy was left behind');

      const [rows] = await connection.query('SELECT COUNT(*) AS n FROM users');
      assert.equal(Number((rows as { n: number }[])[0]!.n), 100);
    } finally {
      await connection.end();
    }
  });
});
