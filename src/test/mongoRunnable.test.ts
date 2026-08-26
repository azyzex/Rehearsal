import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { findJoinPath } from '../analysis/joinPath';
import { Edit } from '../edit/changeset';
import { toMongoStatement } from '../edit/mongoStatements';
import { MongoFixture, seedMongo, startMongo } from './support/mongoFixture';

/**
 * The statements this project writes for MongoDB, actually run by MongoDB.
 *
 * Every other test here checks the *text* — that `$unset` appears where DROP
 * COLUMN used to, that the route is a `$lookup` and not a JOIN. Text that looks
 * right and does not parse is exactly as useless as SQL was, and rather more
 * embarrassing, so this one hands each generated statement to a real server.
 *
 * Run through `eval`, because that is what mongosh does with a script: these
 * are shell syntax, and the point is that the shell would accept them. Nothing
 * here is a string the extension executes at runtime — the extension parses
 * these into driver calls — but a script the user is invited to paste into
 * mongosh had better be one mongosh can read.
 */

describe('what Dry Run writes for MongoDB, run by MongoDB', () => {
  let fixture: MongoFixture;

  before(async () => {
    fixture = await startMongo();
    await seedMongo(fixture.db());
  });

  after(async () => {
    await fixture.stop();
  });

  /**
   * Runs one generated statement the way the shell would.
   *
   * `db.getCollection(…)` is the only global it needs, so it is passed in.
   */
  async function run(statement: string): Promise<unknown> {
    const db = fixture.db();
    const shell = {
      getCollection: (name: string) => db.collection(name),
      createCollection: (name: string) => db.createCollection(name),
    };

    const fn = new Function('db', 'ISODate', `return (${statement});`) as (
      database: unknown,
      isoDate: (value: string) => Date,
    ) => unknown;

    return fn(shell, (value: string) => new Date(value));
  }

  const generated = (edit: Edit): string => toMongoStatement(edit, 0).sql;

  it('runs a $unset that really removes the field', async () => {
    const before = await fixture
      .db()
      .collection('users')
      .countDocuments({ phone_number: { $exists: true } });
    assert.ok(before > 0, 'the fixture has phone numbers to remove');

    await run(generated({ kind: 'drop_column', table: 'users', column: 'phone_number' }));

    assert.equal(
      await fixture.db().collection('users').countDocuments({ phone_number: { $exists: true } }),
      0,
    );
  });

  it('runs a $rename that really moves the field', async () => {
    await run(generated({ kind: 'rename_column', table: 'users', column: 'tier', to: 'plan' }));

    const users = fixture.db().collection('users');
    assert.equal(await users.countDocuments({ tier: { $exists: true } }), 0);
    assert.ok((await users.countDocuments({ plan: { $exists: true } })) > 0);
  });

  it('runs the type change, and keeps what could not convert', async () => {
    // `plan` holds words, which cannot become an int. `onError` is what stops
    // the statement writing null over every one of them.
    const users = fixture.db().collection('users');
    const before = await users.countDocuments({ plan: 'free' });
    assert.ok(before > 0);

    await run(generated({ kind: 'alter_type', table: 'users', column: 'plan', to: 'int' }));

    assert.equal(
      await users.countDocuments({ plan: 'free' }),
      before,
      'a value that cannot convert was overwritten instead of kept',
    );
  });

  it('runs createIndex, and the index is really there', async () => {
    await run(
      generated({
        kind: 'add_index',
        table: 'users',
        columns: ['org_id'],
        unique: false,
        concurrently: false,
      }),
    );

    const names = (await fixture.db().collection('users').indexes()).map((index) => index.name);
    assert.ok(
      names.some((name) => String(name).startsWith('org_id')),
      `indexes are ${names.join(', ')}`,
    );
  });

  it('runs a unique index, and it really rejects a duplicate', async () => {
    const orgs = fixture.db().collection('orgs');
    await run(generated({ kind: 'add_unique', table: 'orgs', columns: ['name'] }));

    await assert.rejects(
      () => orgs.insertOne({ _id: 999 as never, name: 'acme' }),
      /duplicate key/i,
      'the unique index was not enforced',
    );
  });

  it('runs createCollection and drop', async () => {
    await run(generated({ kind: 'create_table', table: 'scratch', columns: [] }));
    const names = await fixture
      .db()
      .listCollections({}, { nameOnly: true })
      .toArray();
    assert.ok(names.some((one) => one.name === 'scratch'));

    await run(generated({ kind: 'drop_table', table: 'scratch' }));
    const after = await fixture
      .db()
      .listCollections({}, { nameOnly: true })
      .toArray();
    assert.ok(!after.some((one) => one.name === 'scratch'));
  });

  it('runs the route between two collections and gets documents back', async () => {
    // The whole point of the pipeline: a SELECT handed to a MongoDB user is a
    // query that cannot run. This one has to run, and has to return something.
    const snapshot = {
      schemas: ['dryrun_test'],
      tables: ['orgs', 'users'].map((name) => ({
        schema: 'dryrun_test',
        name,
        qualified: name,
        rows: 1,
        bytes: 1,
        partitioned: false,
        columns: [],
      })),
      foreignKeys: [
        {
          name: 'users.org_id',
          fromTable: 'users',
          fromColumns: ['org_id'],
          toTable: 'orgs',
          toColumns: ['_id'],
        },
      ],
    };

    const route = findJoinPath(snapshot, 'users', 'orgs');
    assert.ok(route, 'no route found');
    assert.match(route.pipeline, /\$lookup/);
    assert.doesNotMatch(route.pipeline, /SELECT|JOIN/i);

    const rows = (await run(route.pipeline)) as { toArray(): Promise<unknown[]> };
    const documents = await rows.toArray();

    assert.ok(documents.length > 0, 'the pipeline ran and matched nothing');
    assert.ok(
      Object.prototype.hasOwnProperty.call(documents[0], 'orgs'),
      'the looked-up collection is not on the result',
    );
  });
});
