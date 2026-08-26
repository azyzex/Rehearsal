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
