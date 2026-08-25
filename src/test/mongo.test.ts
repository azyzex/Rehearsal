import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoAdapter, NoTransactionsError, flatten, referenceTarget } from '../adapters/mongo';
import { classifyMongo, parseMongo, splitMongo } from '../parser/mongo';
import { APPLICATION_NAME } from '../constants';
import { MongoFixture, seedMongo, startMongo } from './support/mongoFixture';

/**
 * The MongoDB adapter, against a real replica set.
 *
 * Three databases, three answers to the same question. Postgres rolls DDL back.
 * MySQL commits it and the adapter has to refuse it by hand. MongoDB refuses it
 * itself — and adds a condition neither of the others has, because a preview
 * only rolls back on a replica set. The first section is about that.
 */

describe('mongo', () => {
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
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await adapter?.dispose();
    await fixture?.stop();
  });

  describe('what has to be true before it will do anything', () => {
    it('really rolls a change back', async () => {
      await adapter.withRollback(async (tx) => {
        const result = await tx.query(
          `db.users.updateMany({ tier: "free" }, { $set: { tier: "enterprise" } })`,
        );
        assert.ok((result.rowCount ?? 0) > 0, 'the update really ran');

        const inside = await tx.query(`db.users.countDocuments({ tier: "enterprise" })`);
        assert.ok(Number(inside.rows[0]!['n']) > 0, 'and is visible inside the transaction');
      });

      assert.equal(
        await adapter.countRows('users', '{"tier":"enterprise"}'),
        0,
        'and was really undone',
      );
    });

    it('refuses a deployment that cannot roll anything back', async () => {
      // The failure this prevents is the worst one available: a preview
      // against a standalone mongod would apply every change permanently
      // while reporting them as previewed.
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      const standalone = await MongoMemoryServer.create();

      const alone = new MongoAdapter();
      try {
        await assert.rejects(
          () =>
            alone.connect({
              connectionString: `${standalone.getUri()}dryrun`,
              statementTimeoutMs: 10_000,
              lockTimeoutMs: 5000,
              applicationName: APPLICATION_NAME,
            }),
          NoTransactionsError,
        );
      } finally {
        await alone.dispose();
        await standalone.stop();
      }
    });

    it('says so on connect, not on first preview', async () => {
      // Someone pointed at the wrong kind of deployment should find out while
      // connecting, not while looking at numbers they believe were undone.
      const error = new NoTransactionsError('it is a standalone server, not a replica set');
      assert.match(error.message, /apply with a reassuring name/);
      assert.match(error.message, /replica set/);
    });

    it('will not apply a changeset', async () => {
      await assert.rejects(() => adapter.runCommitted(), /cannot run inside a transaction/);
    });

    it('does not pretend to have hypothetical indexes', async () => {
      assert.equal(await adapter.supportsHypotheticalIndexes(), false);
      await assert.rejects(() => adapter.testIndex());
    });

    it('refuses an operation the server would refuse anyway', async () => {
      // MongoDB will not create an index inside a transaction. Rather than
      // find that out from a driver error mid-preview, it is refused here
      // with a sentence that says why.
      await assert.rejects(
        () =>
          adapter.withRollback(async (tx) => {
            await tx.query(`db.users.createIndex({ email: 1 })`);
          }),
        /cannot run inside a transaction/,
      );
    });
  });

  describe('reading a migration', () => {
    it('splits statements across lines and semicolons', () => {
      const statements = splitMongo(`
        // set everyone to basic
        db.users.updateMany(
          { tier: "free" },
          { $set: { tier: "basic" } }
        );
        db.sessions.deleteMany({ expired: true })
      `);

      assert.equal(statements.length, 2);
      assert.match(statements[0]!.sql, /^db\.users\.updateMany/);
      assert.match(statements[1]!.sql, /^db\.sessions\.deleteMany/);
    });

    it('carries offsets, so a row in the panel can jump to the statement', () => {
      const source = `db.a.deleteMany({})
db.b.deleteMany({})`;
      const statements = splitMongo(source);

      assert.equal(statements.length, 2);
      for (const statement of statements) {
        assert.equal(
          source.slice(statement.startOffset, statement.startOffset + statement.sql.length),
          statement.sql,
          'the offset points at the statement it claims to',
        );
      }
    });

    it('does not split inside a string that contains a newline or a brace', () => {
      const statements = splitMongo(`db.notes.updateMany({}, { $set: { body: "a } b" } })`);
      assert.equal(statements.length, 1);
    });

    it('reads the relaxed JSON people actually write', () => {
      const parsed = parseMongo(`db.users.updateMany({ tier: 'free', n: 3 }, { $set: { x: 1 } },)`);
      assert.ok(!('unreadable' in parsed));
      if ('unreadable' in parsed) {
        return;
      }
      assert.deepEqual(parsed.args[0], { tier: 'free', n: 3 });
      assert.equal(parsed.collection, 'users');
      assert.equal(parsed.operation, 'updateMany');
    });

    it('refuses anything it would have to run to understand', () => {
      // A wrong reading here produces a confident number about the wrong
      // documents, which is worse than saying it cannot read the statement.
      const parsed = parseMongo(`db.users.updateMany({ createdAt: { $lt: cutoff } }, {})`);
      assert.ok('unreadable' in parsed);
      if ('unreadable' in parsed) {
        assert.match(parsed.unreadable, /literal values only/);
      }
    });

    it('refuses something that is not a collection operation', () => {
      const parsed = parseMongo(`for (const u of users) { print(u) }`);
      assert.ok('unreadable' in parsed);
    });

    it('reads a $unset as what it is: dropping a field', () => {
      // The same event as DROP COLUMN, so the existing analysis counts how
      // many documents are about to lose a value.
      const found = classifyMongo(`db.users.updateMany({}, { $unset: { phone_number: "" } })`);
      assert.equal(found.kind, 'drop_column');
      assert.equal(found.table, 'users');
      assert.equal(found.column, 'phone_number');
    });

    it('does not read a $set as dropping anything', () => {
      const found = classifyMongo(`db.users.updateMany({}, { $set: { tier: "basic" } })`);
      assert.equal(found.kind, 'update');
    });

    it('notices an update with no filter at all', () => {
      assert.equal(classifyMongo(`db.users.updateMany({}, { $set: { a: 1 } })`).hasWhere, false);
      assert.equal(
        classifyMongo(`db.users.updateMany({ tier: "free" }, { $set: { a: 1 } })`).hasWhere,
        true,
      );
    });

    it('maps the collection operations onto the kinds everything else speaks', () => {
      assert.equal(classifyMongo(`db.sessions.drop()`).kind, 'drop_table');
      assert.equal(classifyMongo(`db.users.createIndex({ email: 1 })`).kind, 'create_index');
      assert.equal(classifyMongo(`db.users.deleteMany({})`).kind, 'delete');
      assert.equal(classifyMongo(`db.users.insertMany([{ a: 1 }])`).kind, 'insert');
    });

    it('carries the index fields through', () => {
      assert.deepEqual(
        classifyMongo(`db.users.createIndex({ email: 1, tier: -1 })`).columns,
        ['email', 'tier'],
      );
    });
  });

  describe('the probes, against the same fixture as the SQL adapters', () => {
    it('counts documents', async () => {
      assert.equal(await adapter.countRows('users'), 100);
      assert.equal(await adapter.countRows('orgs'), 2);
    });

    it('counts documents matching a filter', async () => {
      assert.equal(await adapter.countRows('users', '{"org_id":99}'), 10);
    });

    it('treats a missing field and a null one alike when counting values', async () => {
      // Twelve users have no email: six hold null and six do not have the
      // field at all. Both are "no value", and a count that saw only one of
      // them would be wrong by half.
      assert.equal(await adapter.countNonNull('users', 'email'), 88);
    });

    it('finds the references that point at nothing', async () => {
      assert.equal(await adapter.countOrphans('users', ['org_id'], 'orgs', ['_id']), 10);
    });

    it('finds the duplicates', async () => {
      const { groups, rows } = await adapter.countDuplicates('users', ['email']);
      assert.equal(groups, 1);
      assert.equal(rows, 8);
    });

    it('does not count the missing ones as duplicates', async () => {
      const { rows } = await adapter.countDuplicates('users', ['email']);
      assert.equal(rows, 8, 'the twelve without an email are not a group');
    });

    it('counts documents a filter would exclude', async () => {
      assert.equal(await adapter.countViolating('users', '{"tier":{"$in":["free","pro"]}}'), 0);
      assert.equal(await adapter.countViolating('users', '{"tier":"pro"}'), 67);
    });

    it('reads rows matching a filter', async () => {
      const rows = await adapter.rowsMatching('users', '{"org_id":99}', 5);
      assert.equal(rows.length, 5);
      for (const row of rows) {
        assert.equal(row['org_id'], 99);
      }
    });

    it('sorts when asked', async () => {
      const rows = await adapter.rowsMatching('users', '{}', 5, '_id DESC');
      const ids = rows.map((row) => Number(row['_id']));
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    });

    it('reads the size of a collection', async () => {
      const stats = await adapter.tableStats('users');
      assert.equal(stats.estimatedRows, 100);
      assert.ok(stats.totalBytes > 0);
    });
  });

  describe('a schema that is not written down anywhere', () => {
    it('infers the fields from the documents', async () => {
      const columns = await adapter.tableColumns('users');
      const names = columns.map((column) => column.name);

      assert.ok(names.includes('_id'));
      assert.ok(names.includes('tier'));
      assert.ok(names.includes('email'));
      assert.equal(names[0], '_id', '_id comes first because every document has one');
    });

    it('calls a field nullable when documents are missing it', async () => {
      const columns = await adapter.tableColumns('users');
      const tier = columns.find((column) => column.name === 'tier')!;
      const phone = columns.find((column) => column.name === 'phone_number')!;

      assert.equal(tier.nullable, false, 'every document has a tier');
      assert.equal(phone.nullable, true, 'only half have a phone number');
    });

    it('reports every type a field actually holds', async () => {
      // A field is whatever the documents put in it, and a schema explorer
      // that shows one type for a field holding three is lying quietly.
      await fixture.db().collection('mixed').insertMany([
        { _id: 1, value: 'text' },
        { _id: 2, value: 42 },
      ] as never[]);

      const columns = await adapter.tableColumns('mixed');
      const value = columns.find((column) => column.name === 'value')!;
      assert.match(value.type, /int/);
      assert.match(value.type, /string/);

      await fixture.db().collection('mixed').drop();
    });

    it('reads _id as the primary key, because nothing else is guaranteed', async () => {
      assert.deepEqual(await adapter.primaryKeyColumns('users'), ['_id']);
    });

    it('flattens a nested document the way MongoDB addresses it', () => {
      assert.deepEqual(flatten({ a: 1, b: { c: 2, d: { e: 3 } } }), {
        a: 1,
        'b.c': 2,
        'b.d.e': 3,
      });
    });

    it('leaves an array whole rather than exploding it into columns', () => {
      const row = flatten({ tags: ['a', 'b'] });
      assert.deepEqual(row['tags'], ['a', 'b']);
    });
  });

  describe('relationships, which this database does not have', () => {
    it('suggests a target from a field name', () => {
      const collections = ['users', 'orgs', 'orders'];
      assert.equal(referenceTarget('user_id', collections), 'users');
      assert.equal(referenceTarget('userId', collections), 'users');
      assert.equal(referenceTarget('org_id', collections), 'orgs');
      assert.equal(referenceTarget('_id', collections), undefined);
      assert.equal(referenceTarget('total_cents', collections), undefined);
    });

    it('finds the relationship by counting, not by guessing', async () => {
      // orders.user_id really does hold ids that are in users, so it counts
      // as a relationship even though MongoDB has never heard of one.
      const keys = await adapter.foreignKeys(['users', 'orgs', 'orders']);
      const found = keys.find((key) => key.fromTable === 'orders');

      assert.ok(found, `found: ${JSON.stringify(keys)}`);
      assert.deepEqual(found!.fromColumns, ['user_id']);
      assert.equal(found!.toTable, 'users');
      assert.match(found!.name, /inferred/, 'and says that it is inferred');
    });

    it('refuses a relationship whose values do not line up', async () => {
      // users.org_id points at an org that does not exist for ten per cent of
      // documents, which is still a relationship. A field that matches a
      // tenth of the time is not, and this is the line between them.
      await fixture.db().collection('widgets').insertMany([
        { _id: 1, user_id: 9001 },
        { _id: 2, user_id: 9002 },
        { _id: 3, user_id: 9003 },
      ] as never[]);

      const keys = await adapter.foreignKeys(['users', 'widgets']);
      assert.equal(
        keys.some((key) => key.fromTable === 'widgets'),
        false,
        'sharing a name is not a relationship',
      );

      await fixture.db().collection('widgets').drop();
    });

    it('draws the whole database from what it found', async () => {
      const snapshot = await adapter.schemaSnapshot();
      const names = snapshot.tables.map((table) => table.name).sort();

      assert.deepEqual(names, ['orders', 'orgs', 'users']);
      assert.ok(snapshot.foreignKeys.length > 0, 'and the relationships between them');
      assert.deepEqual(snapshot.schemas, [fixture.database]);
    });
  });

  describe('what a delete would leave behind', () => {
    it('says the documents are orphaned rather than deleted', async () => {
      // MongoDB does not cascade. The problem arrives by a different route:
      // nothing is removed, and forty documents now point at nothing.
      const cascade = await adapter.cascadeImpact('users', '{"_id":1}');

      assert.equal(cascade.table, 'users');
      assert.equal(cascade.rows, 1);

      const orders = cascade.children.find((child) => child.table === 'orders');
      assert.ok(orders, 'the orders that reference a user are reported');
      assert.match(orders!.truncated!, /left\s+pointing at something that is no longer there/);
    });
  });

  describe('one collection in full', () => {
    it('reads its fields, indexes and sample', async () => {
      const detail = await adapter.tableDetail('users', 5);

      assert.equal(detail.table, 'users');
      assert.deepEqual(detail.primaryKey, ['_id']);
      assert.equal(detail.sample.length, 5);
      assert.ok(detail.indexes.some((index) => index.primary), 'the _id index');
    });

    it('finds a document by text across every field', async () => {
      const detail = await adapter.tableDetail('users', 10, 'dupe@example.com');
      assert.ok(detail.sample.length > 0);
      for (const row of detail.sample) {
        assert.equal(row['email'], 'dupe@example.com');
      }
    });

    it('reports a unique index as a constraint, which is what it is here', async () => {
      await fixture.db().collection('users').createIndex({ email: 1 }, { unique: false, name: 'email_1' });
      const detail = await adapter.tableDetail('users', 0);
      assert.ok(detail.indexes.some((index) => index.name === 'email_1'));
      await fixture.db().collection('users').dropIndex('email_1');
    });

    it('says there are no triggers, because there are none', async () => {
      assert.deepEqual(await adapter.triggers('users'), []);
    });
  });

  describe('plans and health', () => {
    it('explains a statement', async () => {
      const plan = await adapter.explain(`db.users.find({ tier: "pro" })`);
      assert.ok(plan.raw);
      assert.ok(JSON.stringify(plan.raw).includes('users'));
    });

    it('reports every collection in the health snapshot', async () => {
      const health = await adapter.schemaHealth();
      const names = health.tables.map((table) => table.table).sort();
      assert.deepEqual(names, ['orders', 'orgs', 'users']);
      assert.equal(health.statsSince, null, 'MongoDB gives no window for these');
    });
  });
});
