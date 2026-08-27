import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoAdapter } from '../adapters/mongo';
import { MysqlAdapter } from '../adapters/mysql';
import { findOffenders } from '../analysis/offenders';
import { Classification } from '../parser/classifier';
import { MongoFixture, seedMongo, startMongo } from './support/mongoFixture';
import { MysqlFixture, seedMysql, startMysql } from './support/mysqlFixture';

/**
 * The offending rows, on the two engines the scan was broken on.
 *
 * "Show me the twelve rows that will stop this migration" is the answer that
 * makes a blocking count worth trusting, and it was built out of SQL predicates
 * quoted the ANSI way. On MySQL `"email" IS NULL` asks whether the constant
 * 'email' is null — never — so the scan found nothing on a table with twelve
 * offences in it and reported that as a clean result. On MongoDB the filter is
 * parsed as JSON and the query threw into an output channel nobody opens, so
 * the panel simply showed nothing.
 *
 * Both fixtures hold exactly twelve rows with no email, on purpose, so the
 * number below is the same one the Postgres tests assert.
 */

const notNull = (table: string, column: string): Classification =>
  ({ kind: 'set_not_null', table, column }) as Classification;

describe('the offending rows, per engine', () => {
  describe('against a real MySQL', () => {
    let fixture: MysqlFixture;
    let adapter: MysqlAdapter;

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
        statementTimeoutMs: 20_000,
        lockTimeoutMs: 5000,
        applicationName: 'vscode-dryrun',
      });
    });

    after(async () => {
      await adapter.dispose().catch(() => undefined);
      await fixture.stop();
    });

    it('finds the twelve rows, where it used to find none', async () => {
      const found = await findOffenders(adapter, notNull('users', 'email'), 25);

      assert.ok(found, 'the scan returned nothing at all');
      assert.equal(found.kind, 'null');
      assert.equal(found.total, 12);
      assert.equal(found.rows.length, 12);
    });

    it('returns the rows themselves, not just a count', async () => {
      // The count was already right elsewhere. The rows are the part that makes
      // it actionable, and they are what the broken filter cost.
      const found = await findOffenders(adapter, notNull('users', 'email'), 5);

      assert.equal(found!.rows.length, 5, 'the limit is respected');
      for (const row of found!.rows) {
        assert.equal(row['email'], null, 'a row came back that is not an offender');
      }
    });

    it('quotes the fix the way MySQL would', async () => {
      const found = await findOffenders(adapter, notNull('users', 'email'), 5);
      assert.match(found!.fix!.sql, /UPDATE users SET email/);
      assert.equal(found!.fix!.needsEditing, true);
    });
  });

  describe('against a real MongoDB', () => {
    let fixture: MongoFixture;
    let adapter: MongoAdapter;

    before(async () => {
      fixture = await startMongo();
      await seedMongo(fixture.db());

      adapter = new MongoAdapter();
      await adapter.connect({
        connectionString: fixture.uri,
        statementTimeoutMs: 20_000,
        lockTimeoutMs: 5000,
        applicationName: 'vscode-dryrun',
      });
    });

    after(async () => {
      await adapter.dispose().catch(() => undefined);
      await fixture.stop();
    });

    it('finds the documents with no value, counting missing and null alike', async () => {
      // Six hold `email: null` and six have no `email` key. Both mean no value
      // and both would fail a required field, and `{ email: null }` is the one
      // filter that matches them both.
      const found = await findOffenders(adapter, notNull('users', 'email'), 25);

      assert.ok(found, 'the scan returned nothing at all');
      assert.equal(found.total, 12);
      assert.equal(found.rows.length, 12);
    });

    it('offers a fix written as an operation, not as SQL', async () => {
      const found = await findOffenders(adapter, notNull('users', 'email'), 5);

      assert.match(found!.fix!.sql, /db\.getCollection\("users"\)\.updateMany/);
      assert.match(found!.fix!.sql, /\$set/);
      assert.doesNotMatch(found!.fix!.sql, /UPDATE |SET .*=.* WHERE/);
      assert.match(found!.fix!.note, /operation/, 'and calls it what MongoDB calls it');
    });

    it('says nothing rather than throwing for the questions it cannot ask', async () => {
      // Orphans need a NOT EXISTS and duplicates need a GROUP BY, and neither
      // is a filter a collection can be handed. Returning nothing is the honest
      // answer; throwing put the reason in a log nobody opens and left the
      // panel blank either way.
      const orphans = await findOffenders(
        adapter,
        {
          kind: 'add_foreign_key',
          table: 'users',
          columns: ['org_id'],
          references: { table: 'orgs', columns: ['_id'] },
        } as Classification,
        25,
      );
      assert.equal(orphans, undefined);

      const duplicates = await findOffenders(
        adapter,
        { kind: 'add_unique', table: 'users', columns: ['email'] } as Classification,
        25,
      );
      assert.equal(duplicates, undefined);
    });
  });
});

/**
 * The three adapter methods no test had ever called away from Postgres.
 *
 * Found by asking which methods of the interface each engine's tests reach:
 * `countCastFailures`, `sampleRows` and `lockHolders` were called on Postgres
 * and on neither of the others.
 *
 * The first of those was broken, in the way that matters: it reported that a
 * type change would fail on none of a hundred rows when it fails on every one
 * of them. That is the same wrong answer, in the same direction, as the NOT
 * NULL probe that once called a failing MySQL migration safe — a green row for
 * a statement that errors.
 */
describe('the probes nothing had run off Postgres', () => {
  describe('against a real MySQL', () => {
    let fixture: MysqlFixture;
    let adapter: MysqlAdapter;

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
        statementTimeoutMs: 20_000,
        lockTimeoutMs: 5000,
        applicationName: 'vscode-dryrun',
      });
    });

    after(async () => {
      await adapter.dispose().catch(() => undefined);
      await fixture.stop();
    });

    it('counts every row a type change cannot convert', async () => {
      // 88 of the 100 hold an email address, and not one of them is an integer.
      // This answered 0: MySQL's CAST returns 0 rather than raising, and
      // comparing that against the original made MySQL coerce the original to a
      // number too, so 0 matched 0 and every row looked convertible.
      assert.equal(await adapter.countCastFailures('users', 'email', 'int'), 88);
    });

    it('counts a column of words as entirely unconvertible', async () => {
      assert.equal(await adapter.countCastFailures('users', 'tier', 'int'), 100);
    });

    it('counts none on a column that really is integers', async () => {
      // The half that has to stay true for the answer to be worth anything: a
      // probe that says "everything fails" is as useless as one that says
      // nothing does.
      assert.equal(await adapter.countCastFailures('users', 'id', 'int'), 0);
    });

    it('says it does not know, rather than zero, for a type it cannot test', async () => {
      assert.equal(await adapter.countCastFailures('users', 'email', 'jsonb'), null);
    });

    it('reads back the rows a preview changed, by their keys', async () => {
      const rows = await adapter.sampleRows('users', [{ id: 1 }, { id: 2 }, { id: 3 }], 3);

      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((row) => Number(row['id'])),
        [1, 2, 3],
      );
      assert.ok('tier' in rows[0]!, 'the row came back without its columns');
    });

    it('answers the lock question without falling over', async () => {
      // Nothing is holding a lock in an idle fixture, and an empty list is the
      // right answer — but the query behind it is engine-specific and had
      // never run in a test.
      assert.deepEqual(await adapter.lockHolders('users'), []);
    });
  });

  describe('against a real MongoDB', () => {
    let fixture: MongoFixture;
    let adapter: MongoAdapter;

    before(async () => {
      fixture = await startMongo();
      await seedMongo(fixture.db());

      adapter = new MongoAdapter();
      await adapter.connect({
        connectionString: fixture.uri,
        statementTimeoutMs: 20_000,
        lockTimeoutMs: 5000,
        applicationName: 'vscode-dryrun',
      });
    });

    after(async () => {
      await adapter.dispose().catch(() => undefined);
      await fixture.stop();
    });

    it('counts the documents a type change cannot convert', async () => {
      // `tier` holds 'free' and 'pro' on all hundred.
      assert.equal(await adapter.countCastFailures('users', 'tier', 'int'), 100);
    });

    it('counts none where the field already holds that type', async () => {
      assert.equal(await adapter.countCastFailures('users', 'org_id', 'int'), 0);
      assert.equal(await adapter.countCastFailures('users', 'org_id', 'string'), 0);
    });

    it('reads back documents by their _id', async () => {
      const rows = await adapter.sampleRows('users', [{ _id: 1 }, { _id: 2 }], 2);

      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => Number(row['_id'])),
        [1, 2],
      );
    });

    it('answers the lock question without falling over', async () => {
      assert.deepEqual(await adapter.lockHolders('users'), []);
    });
  });
});
