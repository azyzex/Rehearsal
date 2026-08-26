import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoAdapter } from '../adapters/mongo';
import { Edit } from '../edit/changeset';
import { dialectFor } from '../edit/dialect';
import { mongoDownMigration } from '../edit/mongoDown';
import { MongoFixture, seedMongo, startMongo } from './support/mongoFixture';

/**
 * The script that undoes a changeset, for MongoDB.
 *
 * Generated against the live database before the change runs, so the index it
 * recreates is the index that was really there. The half of a changeset that
 * is exactly reversible — a rename, an index, a renamed collection — comes back
 * as an operation. The half that is not says so and points at the rescue file,
 * because a down migration with gaps is worth having and one that hides them
 * is worse than none.
 *
 * Every statement here is run against a real MongoDB at the end, because a
 * down migration that does not parse is a down migration that fails on the one
 * night it is needed.
 */

describe('undoing a changeset, in MongoDB', () => {
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

  const down = (edits: readonly Edit[]) => mongoDownMigration(adapter, edits);

  it('is offered at all, which it was not for one commit', () => {
    assert.equal(dialectFor('mongo').hasDownMigration, true);
  });

  it('renames a field back', async () => {
    const result = await down([
      { kind: 'rename_column', table: 'users', column: 'tier', to: 'plan' },
    ]);

    assert.deepEqual(result.gaps, [], 'a rename loses nothing, so there is nothing to warn about');
    assert.match(
      result.statements[0]!,
      /\$rename: \{ "plan": "tier" \}/,
      'the reversal renames the new name back to the old one, not the other way round',
    );
  });

  it('renames a collection back', async () => {
    const result = await down([{ kind: 'rename_table', table: 'users', to: 'people' }]);

    assert.deepEqual(result.gaps, []);
    assert.match(result.statements[0]!, /getCollection\("people"\)\.renameCollection\("users"\)/);
  });

  it('drops an index it created, by the name MongoDB gave it', async () => {
    // `{ a: 1, b: 1 }` is named `a_1_b_1` unless you name it. Getting this
    // wrong produces a dropIndex on a name that never existed, which is a down
    // migration that stops halfway.
    const result = await down([
      {
        kind: 'add_index',
        table: 'users',
        columns: ['org_id', 'tier'],
        unique: false,
        concurrently: false,
      },
    ]);

    assert.deepEqual(result.gaps, []);
    assert.match(result.statements[0]!, /dropIndex\("org_id_1_tier_1"\)/);
  });

  it('uses the name it was given, when it was given one', async () => {
    const result = await down([
      {
        kind: 'add_index',
        table: 'users',
        columns: ['org_id'],
        unique: false,
        concurrently: false,
        name: 'by_org',
      },
    ]);
    assert.match(result.statements[0]!, /dropIndex\("by_org"\)/);
  });

  it('drops a collection it created', async () => {
    const result = await down([{ kind: 'create_table', table: 'scratch', columns: [] }]);
    assert.deepEqual(result.gaps, []);
    assert.match(result.statements[0]!, /getCollection\("scratch"\)\.drop\(\)/);
  });

  it('undoes the last thing first', async () => {
    // Undoing in the original order renames a collection that has not been
    // recreated yet.
    const result = await down([
      { kind: 'rename_column', table: 'users', column: 'a', to: 'b' },
      { kind: 'create_table', table: 'scratch', columns: [] },
    ]);

    assert.match(result.statements[0]!, /scratch/, 'the last edit is undone first');
    assert.match(result.statements[1]!, /\$rename/);
  });

  describe('what it cannot undo, said out loud', () => {
    it('says the values a $unset took are gone', async () => {
      const result = await down([
        { kind: 'drop_column', table: 'users', column: 'phone_number' },
      ]);

      assert.deepEqual(result.statements, [], 'nothing is emitted that pretends to restore them');
      assert.equal(result.gaps.length, 1);
      assert.match(result.gaps[0]!, /rescue file/);
      assert.match(result.gaps[0]!, /phone_number/);
    });

    it('says a dropped collection comes back empty', async () => {
      const result = await down([{ kind: 'drop_table', table: 'orgs' }]);

      assert.match(result.statements[0]!, /createCollection\("orgs"\)/);
      assert.match(result.gaps[0]!, /comes back empty/);
      assert.match(result.gaps[0]!, /without the indexes/);
    });

    it('says a backfill cannot be told apart from what was already there', async () => {
      const result = await down([
        {
          kind: 'add_column',
          table: 'users',
          column: 'tier',
          type: 'string',
          nullable: true,
          defaultExpression: 'free',
        },
      ]);

      assert.deepEqual(result.statements, []);
      assert.match(result.gaps[0]!, /no longer distinguishable/);
    });

    it('says a type change gives back the type, not the precision', async () => {
      const result = await down([
        { kind: 'alter_type', table: 'users', column: 'org_id', to: 'string' },
      ]);

      assert.match(result.statements[0]!, /\$convert/);
      assert.match(result.gaps[0]!, /not the precision/);
    });

    it('points a row edit at the rescue file rather than guessing', async () => {
      for (const edit of [
        { kind: 'delete_row', table: 'users', key: { _id: 1 } },
        { kind: 'update_row', table: 'users', key: { _id: 1 }, set: { tier: 'pro' } },
      ] as Edit[]) {
        const result = await down([edit]);
        assert.deepEqual(result.statements, []);
        assert.match(result.gaps[0]!, /rescue file/);
      }
    });
  });

  describe('the file it writes', () => {
    it('is commented the JavaScript way, and says where the numbers came from', async () => {
      const result = await down([
        { kind: 'rename_column', table: 'users', column: 'tier', to: 'plan' },
      ]);

      assert.match(result.sql, /^\/\/ Down script/);
      assert.match(result.sql, /against the live database before the/);
      assert.doesNotMatch(result.sql, /^-- /m, 'no SQL comments anywhere in it');
      assert.match(result.sql, /mongosh/, 'and says how to run it');
    });

    it('puts the gaps at the top, where they will be read', async () => {
      const result = await down([
        { kind: 'drop_column', table: 'users', column: 'phone_number' },
        { kind: 'rename_column', table: 'users', column: 'tier', to: 'plan' },
      ]);

      const gapsAt = result.sql.indexOf('What this does NOT undo');
      const firstStatement = result.sql.indexOf('$rename');
      assert.ok(gapsAt >= 0, 'the gaps are in the file');
      assert.ok(gapsAt < firstStatement, 'and above the statements, not below them');
    });

    it('says so plainly when there is nothing it can run', async () => {
      const result = await down([
        { kind: 'drop_column', table: 'users', column: 'phone_number' },
      ]);
      assert.match(result.sql, /Nothing here is reversible by an operation alone/);
    });
  });

  it('writes statements a real MongoDB accepts', async () => {
    // The whole point. A down migration that does not parse fails on the one
    // night it is needed, and nothing before this ran one.
    const db = fixture.db();
    const shell = {
      getCollection: (name: string) => db.collection(name),
      createCollection: (name: string) => db.createCollection(name),
    };

    // Forward first, so there is something real to undo: an index, a renamed
    // field, and a collection that did not exist.
    await db.collection('users').createIndex({ org_id: 1 });
    await db.collection('users').updateMany({}, { $rename: { tier: 'plan' } });
    await db.createCollection('scratch');

    const result = await down([
      {
        kind: 'add_index',
        table: 'users',
        columns: ['org_id'],
        unique: false,
        concurrently: false,
      },
      { kind: 'rename_column', table: 'users', column: 'tier', to: 'plan' },
      { kind: 'create_table', table: 'scratch', columns: [] },
    ]);

    for (const statement of result.statements) {
      const fn = new Function('db', `return (${statement});`) as (database: unknown) => unknown;
      await fn(shell);
    }

    const users = db.collection('users');
    assert.equal(await users.countDocuments({ plan: { $exists: true } }), 0, 'the rename came back');
    assert.ok((await users.countDocuments({ tier: { $exists: true } })) > 0);

    const indexes = (await users.indexes()).map((index) => String(index.name));
    assert.ok(!indexes.includes('org_id_1'), `the index is still there: ${indexes.join(', ')}`);

    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    assert.ok(!collections.some((one) => one.name === 'scratch'), 'the collection is still there');
  });
});
