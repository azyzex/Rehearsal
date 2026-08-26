import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoAdapter } from '../adapters/mongo';
import { MysqlAdapter } from '../adapters/mysql';
import { Edit } from '../edit/changeset';
import { captureRescue } from '../edit/rescue';
import { rescueWriterFor } from '../edit/rescueWriter';
import { MongoFixture, seedMongo, startMongo } from './support/mongoFixture';
import { MysqlFixture, seedMysql, startMysql } from './support/mysqlFixture';

/**
 * The rescue file, on the two engines it was broken on.
 *
 * This is the safety net — the copy taken before the one irreversible thing the
 * extension does — and it was written entirely in SQL. Both halves of that were
 * wrong away from Postgres, and the half nobody would have noticed is the one
 * that mattered more.
 *
 * Finding the rows a `DROP COLUMN` is about to empty means asking for "the ones
 * with a value in it", which was built as `"column" IS NOT NULL`. MySQL reads
 * `"column"` as the string 'column' — never null — so it matched every row and
 * the file filled with the nulls it exists to keep out of the way. MongoDB
 * parses filters as JSON and threw outright, so a rescue on a `$unset` produced
 * no file at all: the net missing at the exact moment it was being relied on.
 *
 * Both are checked here against real servers, because the shape of this bug is
 * that it looks fine until a real engine reads it.
 */

const CAPTURED = 12;

describe('the rescue file, per engine', () => {
  describe('the filters it asks with', () => {
    it('quotes an identifier the way each engine actually quotes one', () => {
      assert.match(rescueWriterFor('postgres').hasValue('phone'), /"phone" IS NOT NULL/);
      assert.match(rescueWriterFor('mysql').hasValue('phone'), /`phone` IS NOT NULL/);
    });

    it('asks MongoDB in JSON, and asks for present-and-not-null', () => {
      // A missing field and a null one are different things here, and both mean
      // "no value". Asking only about null would miss half the documents.
      const filter = JSON.parse(rescueWriterFor('mongo').hasValue('phone')) as Record<
        string,
        unknown
      >;
      assert.deepEqual(filter, { phone: { $exists: true, $ne: null } });
    });
  });

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

    it('keeps only the rows that have a value, not every row', async () => {
      // 50 of the 100 have a phone number. Before the fix this captured all
      // 100, and the fifty nulls buried the fifty that mattered.
      const change: Edit = { kind: 'drop_column', table: 'users', column: 'phone_number' };
      const file = await captureRescue(adapter, [change], { limit: 1000 });

      assert.equal(file.sections.length, 1);
      assert.equal(file.sections[0]!.total, 50, `captured ${file.sections[0]!.total} of 50`);
    });

    it('writes statements MySQL can read, quoted its way', async () => {
      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_column', table: 'users', column: 'phone_number' }],
        { limit: 3 },
      );

      const restore = file.sections[0]!.restore.join('\n');
      assert.match(restore, /UPDATE `users` SET `phone_number` =/);
      assert.doesNotMatch(restore, /"users"|"phone_number"/, 'ANSI quotes are a string here');
    });

    it('says nothing at all about a column that is null everywhere', async () => {
      // A rescue section full of nulls hides the ones that matter.
      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_column', table: 'users', column: 'nickname' }],
        { limit: 100 },
      );
      assert.deepEqual(file.sections, []);
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

    it('produces a file at all, which it could not before', async () => {
      // The filter was SQL, the adapter parses filters as JSON, and this threw.
      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_column', table: 'users', column: 'phone_number' }],
        { limit: 1000 },
      );

      assert.equal(file.sections.length, 1, 'no section was captured');
      assert.equal(file.sections[0]!.total, 50);
    });

    it('counts a missing field and a null one alike', async () => {
      // Six documents hold `email: null` and six have no `email` key. Both mean
      // no value, so 88 of the 100 have one.
      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_column', table: 'users', column: 'email' }],
        { limit: 1000 },
      );
      assert.equal(file.sections[0]!.total, 88);
    });

    it('writes operations, not INSERT INTO', async () => {
      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_table', table: 'orgs' }],
        { limit: 10 },
      );

      const restore = file.sections[0]!.restore.join('\n');
      assert.match(restore, /db\.getCollection\("orgs"\)\.insertOne\(/);
      assert.doesNotMatch(restore, /INSERT INTO|UPDATE .* SET .* WHERE/);
    });

    it('comments the file the JavaScript way', async () => {
      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_table', table: 'orgs' }],
        { limit: 5 },
      );

      assert.match(file.sql, /^\/\/ Dry Run rescue file/);
      assert.doesNotMatch(file.sql, /^-- /m);
      assert.match(file.sql, /These operations put back/);
    });

    it('restores a field onto the document its key identifies', async () => {
      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_column', table: 'users', column: 'phone_number' }],
        { limit: CAPTURED },
      );

      const first = file.sections[0]!.restore[0]!;
      assert.match(first, /\.updateOne\(\{ "_id": \d+ \}, \{ \$set: \{ "phone_number": /);
    });

    it('writes what it captured back, and it really goes back', async () => {
      // The whole promise of the file: run it and the values return. Nothing
      // before this had ever run one.
      const users = fixture.db().collection('users');
      const before = await users
        .find({ phone_number: { $exists: true, $ne: null } })
        .sort({ _id: 1 })
        .limit(5)
        .toArray();
      assert.ok(before.length > 0);

      const file = await captureRescue(
        adapter,
        [{ kind: 'drop_column', table: 'users', column: 'phone_number' }],
        { limit: 5 },
      );

      // Destroy it, the way the changeset would have.
      await users.updateMany({}, { $unset: { phone_number: '' } });
      assert.equal(await users.countDocuments({ phone_number: { $exists: true } }), 0);

      const db = fixture.db();
      const shell = { getCollection: (name: string) => db.collection(name) };
      for (const statement of file.sections[0]!.restore) {
        const fn = new Function('db', 'ISODate', `return (${statement.replace(/;$/, '')});`) as (
          database: unknown,
          isoDate: (value: string) => Date,
        ) => Promise<unknown>;
        await fn(shell, (value: string) => new Date(value));
      }

      const restored = await users
        .find({ phone_number: { $exists: true } })
        .sort({ _id: 1 })
        .toArray();

      assert.equal(restored.length, 5, 'the rescue put back a different number of documents');
      assert.deepEqual(
        restored.map((one) => one['phone_number']),
        before.map((one) => one['phone_number']),
        'the values that came back are not the values that went in',
      );
    });
  });
});
