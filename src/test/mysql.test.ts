import assert from 'node:assert/strict';
import type { Connection } from 'mysql2/promise';
import { after, before, describe, it } from 'node:test';
import { MysqlAdapter, NonTransactionalDdlError, findImplicitCommit } from '../adapters/mysql';
import { TransactionControlError } from '../adapters/types';
import { APPLICATION_NAME } from '../constants';
import { MysqlFixture, seedMysql, startMysql } from './support/mysqlFixture';

/**
 * The MySQL adapter, against a real MySQL.
 *
 * The first section is the whole reason this adapter reads the way it does.
 * Postgres has transactional DDL; MySQL does not, and an ALTER sent inside a
 * transaction is committed the instant it runs. Everything else here is the
 * ordinary work of a second adapter — the same probes, the same answers — and
 * the fixture is deliberately identical to the Postgres one so that a
 * difference in a result is a difference in the adapter.
 */

describe('mysql', () => {
  let fixture: MysqlFixture;
  let adapter: MysqlAdapter;
  let db: Connection;

  before(async () => {
    fixture = await startMysql();
    db = await fixture.connect();
    await seedMysql(db);

    adapter = new MysqlAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 5000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await adapter?.dispose();
    await db?.end().catch(() => undefined);
    await fixture?.stop();
  });

  describe('the thing MySQL cannot do', () => {
    it('rolls back data like any other database', async () => {
      await adapter.withRollback(async (tx) => {
        await tx.query(`UPDATE users SET tier = 'enterprise'`);
        const inside = await tx.query(
          `SELECT COUNT(*) AS n FROM users WHERE tier = 'enterprise'`,
        );
        assert.equal(Number(inside.rows[0]!['n']), 100, 'the update really ran');
      });

      const [rows] = await db.query(`SELECT COUNT(*) AS n FROM users WHERE tier = 'enterprise'`);
      assert.equal(Number((rows as { n: number }[])[0]!.n), 0, 'and was really undone');
    });

    it('refuses DDL rather than committing it and saying otherwise', async () => {
      // This is the assertion the whole adapter exists for. Without the
      // refusal the ALTER below would be applied, permanently, while the panel
      // said nothing was committed.
      await assert.rejects(
        () =>
          adapter.withRollback(async (tx) => {
            await tx.query('ALTER TABLE users ADD COLUMN sneaky int');
          }),
        NonTransactionalDdlError,
      );

      const [rows] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'sneaky'`,
        [fixture.database],
      );
      assert.equal(Number((rows as { n: number }[])[0]!.n), 0, 'nothing was added');
    });

    it('proves the refusal is load-bearing rather than decorative', async () => {
      // The same statement, sent straight down the driver, does survive a
      // rollback. If this ever stops being true the refusal can be relaxed;
      // until then it is the only thing standing between a preview and a
      // permanent schema change.
      await db.query('START TRANSACTION');
      await db.query('ALTER TABLE users ADD COLUMN proof int');
      await db.query('ROLLBACK');

      const [rows] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'proof'`,
        [fixture.database],
      );
      assert.equal(
        Number((rows as { n: number }[])[0]!.n),
        1,
        'MySQL kept the column through a ROLLBACK, which is exactly the problem',
      );

      await db.query('ALTER TABLE users DROP COLUMN proof');
    });

    it('still refuses transaction control', async () => {
      await assert.rejects(
        () => adapter.withRollback(async (tx) => void (await tx.query('COMMIT'))),
        TransactionControlError,
      );
    });

    it('refuses to apply a changeset at all', async () => {
      // A changeset is meant to be all or nothing. On MySQL a changeset
      // containing DDL cannot be, because the second statement commits the
      // first — so it is refused rather than half-promised.
      await assert.rejects(() => adapter.runCommitted(), NonTransactionalDdlError);
    });

    it('says so about hypothetical indexes rather than building one', async () => {
      assert.equal(await adapter.supportsHypotheticalIndexes(), false);
      await assert.rejects(
        () => adapter.testIndex('CREATE INDEX x ON users (tier)', 'SELECT 1', [], { build: true }),
        NonTransactionalDdlError,
        'the Postgres fallback builds it inside a transaction; here it would stay',
      );
    });

    it('reports what it is', () => {
      assert.equal(adapter.supportsTransactionalDDL, false);
      assert.equal(adapter.engine, 'mysql');
    });
  });

  describe('recognising what commits itself', () => {
    it('catches every shape of DDL', () => {
      for (const sql of [
        'ALTER TABLE users ADD COLUMN x int',
        'create index i on users (tier)',
        'DROP TABLE users',
        'TRUNCATE TABLE users',
        'RENAME TABLE users TO people',
        '  \n  ALTER TABLE users DROP COLUMN x',
      ]) {
        assert.ok(findImplicitCommit(sql), `missed: ${sql}`);
      }
    });

    it('sees through a leading comment', () => {
      // A migration file's first line is very often a comment, and a check
      // that only reads the first word would wave the statement through.
      assert.equal(findImplicitCommit('-- add the column\nALTER TABLE users ADD x int'), 'ALTER');
      assert.equal(findImplicitCommit('/* step 1 */ DROP TABLE users'), 'DROP');
      assert.equal(findImplicitCommit('# comment\nCREATE INDEX i ON users (tier)'), 'CREATE');
    });

    it('lets data statements through', () => {
      for (const sql of [
        `UPDATE users SET tier = 'free'`,
        'DELETE FROM users WHERE id = 1',
        `INSERT INTO users (email) VALUES ('a@example.com')`,
        'SELECT * FROM users',
        `-- alter the data, not the table\nUPDATE users SET tier = 'pro'`,
      ]) {
        assert.equal(findImplicitCommit(sql), null, `wrongly refused: ${sql}`);
      }
    });

    it('is not fooled by a column called alter', () => {
      assert.equal(findImplicitCommit('SELECT alter_ego FROM users'), null);
      assert.equal(findImplicitCommit('UPDATE users SET created_at = now()'), null);
    });
  });

  describe('the probes, against the same fixture as Postgres', () => {
    it('counts rows', async () => {
      assert.equal(await adapter.countRows('users'), 100);
      assert.equal(await adapter.countRows('orgs'), 2);
    });

    it('counts rows matching a predicate, with parameters', async () => {
      assert.equal(await adapter.countRows('users', 'org_id = ?', [99]), 10);
    });

    it('counts the nulls that block a NOT NULL', async () => {
      assert.equal(await adapter.countNonNull('users', 'email'), 88, '12 are null');
    });

    it('counts the orphans that block a foreign key', async () => {
      assert.equal(await adapter.countOrphans('users', ['org_id'], 'orgs', ['id']), 10);
    });

    it('counts the duplicates that block a unique constraint', async () => {
      const { groups, rows } = await adapter.countDuplicates('users', ['email']);
      assert.equal(groups, 1);
      assert.equal(rows, 8);
    });

    it('does not count nulls as duplicates', async () => {
      // Twelve rows have no email, and a unique constraint permits all of
      // them. Counting them would report a failure that will not happen.
      const { rows } = await adapter.countDuplicates('users', ['email']);
      assert.equal(rows, 8, 'the twelve nulls are not in the count');
    });

    it('counts rows violating a check', async () => {
      assert.equal(await adapter.countViolating('users', 'CHAR_LENGTH(tier) > 4'), 100);
      assert.equal(await adapter.countViolating('users', 'id > 0'), 0);
    });

    it('reads the columns, with their types and keys', async () => {
      const columns = await adapter.tableColumns('users');
      assert.deepEqual(
        columns.map((column) => column.name),
        ['id', 'email', 'tier', 'phone_number', 'nickname', 'org_id'],
      );

      const id = columns[0]!;
      assert.equal(id.isPrimaryKey, true);
      assert.equal(id.nullable, false);
      assert.equal(id.identity, 'by default', 'AUTO_INCREMENT is MySQL saying identity');

      const tier = columns.find((column) => column.name === 'tier')!;
      assert.equal(tier.nullable, false);
      assert.equal(tier.defaultExpression, 'free');
    });

    it('reads the primary key', async () => {
      assert.deepEqual(await adapter.primaryKeyColumns('users'), ['id']);
    });

    it('reads the size of a table', async () => {
      const stats = await adapter.tableStats('users');
      assert.equal(stats.table, 'users');
      assert.equal(stats.estimatedRows, 100, 'small tables are counted, not estimated');
      assert.ok(stats.totalBytes > 0);
    });

    it('reads rows matching a predicate', async () => {
      const rows = await adapter.rowsMatching('users', 'email IS NULL', 5);
      assert.equal(rows.length, 5);
      for (const row of rows) {
        assert.equal(row['email'], null);
      }
    });

    it('orders when asked, so duplicate groups stay together', async () => {
      const rows = await adapter.rowsMatching('users', '1 = 1', 5, '`id` DESC');
      const ids = rows.map((row) => Number(row['id']));
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    });
  });

  describe('the schema', () => {
    it('reads every table and its columns', async () => {
      const snapshot = await adapter.schemaSnapshot();
      const names = snapshot.tables.map((table) => table.name).sort();
      assert.deepEqual(names, ['orgs', 'users']);

      const users = snapshot.tables.find((table) => table.name === 'users')!;
      assert.equal(users.columns.length, 6);
      assert.deepEqual(snapshot.schemas, [fixture.database]);
    });

    it('does not qualify names, because MySQL has one schema per connection', async () => {
      const snapshot = await adapter.schemaSnapshot();
      for (const table of snapshot.tables) {
        assert.equal(table.qualified, table.name, 'putting the database on every card is noise');
      }
    });

    it('reads one table in full', async () => {
      const detail = await adapter.tableDetail('users', 5);
      assert.equal(detail.table, 'users');
      assert.deepEqual(detail.primaryKey, ['id']);
      assert.equal(detail.sample.length, 5);
      assert.ok(detail.indexes.some((index) => index.primary));
    });

    it('finds a row by text across every column', async () => {
      const detail = await adapter.tableDetail('users', 10, 'dupe@example.com');
      assert.ok(detail.sample.length > 0, 'the filter found something');
      for (const row of detail.sample) {
        assert.equal(row['email'], 'dupe@example.com');
      }
    });

    it('says nothing about triggers on a table with none', async () => {
      assert.deepEqual(await adapter.triggers('users'), []);
    });

    it('reads a trigger and what it does', async () => {
      await db.query(`
        CREATE TRIGGER users_touch BEFORE UPDATE ON users
        FOR EACH ROW SET NEW.tier = NEW.tier
      `);

      const triggers = await adapter.triggers('users');
      assert.equal(triggers.length, 1);
      assert.equal(triggers[0]!.name, 'users_touch');
      assert.equal(triggers[0]!.timing, 'before');
      assert.deepEqual(triggers[0]!.events, ['update']);
      assert.deepEqual(triggers[0]!.escapes, []);

      await db.query('DROP TRIGGER users_touch');
    });

    it('flags a trigger that writes outside the database', async () => {
      await db.query(`
        CREATE TRIGGER users_leak AFTER UPDATE ON users
        FOR EACH ROW
        BEGIN
          SELECT NEW.id INTO OUTFILE '/tmp/dryrun-leak.txt';
        END
      `);

      const trigger = (await adapter.triggers('users')).find((t) => t.name === 'users_leak')!;
      assert.ok(
        trigger.escapes.some((escape) => /writes a file/.test(escape)),
        `escapes were ${JSON.stringify(trigger.escapes)}`,
      );

      await db.query('DROP TRIGGER users_leak');
    });
  });

  describe('reading a plan', () => {
    it('comes back as something the plan readers understand', async () => {
      const plan = await adapter.explain('SELECT * FROM users WHERE tier = ?', false, ['pro']);
      assert.ok(plan.raw, 'a plan came back');
      assert.ok(JSON.stringify(plan.raw).includes('users'));
    });

    it('refuses EXPLAIN ANALYZE, which runs the statement', async () => {
      await assert.rejects(() => adapter.explain('SELECT 1', true), /executes the statement/);
    });
  });

  describe('identifier quoting', () => {
    it('refuses a name it cannot quote safely', async () => {
      // A table name containing a null byte is not a typo to be cleaned up.
      await assert.rejects(() => adapter.countRows('users '), /Invalid identifier/);
    });

    it('does not let a backtick escape the quoting', async () => {
      await assert.rejects(
        () => adapter.countRows('users` WHERE 1=1 -- '),
        (error: Error) => !/syntax/i.test(error.message),
        'a stripped backtick must not produce a running statement',
      );
    });
  });
});
