import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoFixture, seedMongo, startMongo } from './support/mongoFixture';
import {
  Recorded,
  installVscode,
  makeDocument,
  makeVscodeStub,
  openEditor,
} from './support/vscodeStub';

/**
 * The same migration again, against a real MongoDB.
 *
 * The third engine, and the one where almost nothing about the mechanism
 * carries over. The file is not SQL. There are no columns to drop. A document
 * missing a field and a document holding null are different things, and both
 * mean "no value" for the question being asked. The transaction that makes a
 * preview a preview needs a replica set, which the fixture is.
 *
 * The collection is seeded to match the SQL fixtures row for row — the same
 * hundred users, the same two thirds free, the same twelve without an email,
 * six of them null and six missing the field entirely. So the numbers should
 * come out the same, by a completely different route.
 */

const RUN_TIMEOUT = 120_000;

/**
 * The shape the fixture really inserts.
 *
 * Declared because `_id` here is a number, and the driver's default typing
 * assumes an ObjectId — leaving it to infer turns every `_id` filter below into
 * a type error about a field this data does not have.
 */
interface UserDocument {
  _id: number;
  tier: string;
  email?: string | null;
  phone_number?: string;
  org_id: number;
}

async function waitForMessage(
  recorded: Recorded,
  type: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    for (const panel of recorded.panels) {
      const found = panel.posted.find((message) => message['type'] === type);
      if (found) {
        return found;
      }
    }

    if (Date.now() > deadline) {
      const seen = recorded.panels
        .flatMap((panel) => panel.posted.map((message) => String(message['type'])))
        .join(', ');
      throw new Error(`no ${type} message arrived. Saw: ${seen || 'nothing at all'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const MIGRATION = [
  'db.users.deleteMany({ tier: "free" })',
  '',
  'db.users.updateMany({ _id: { $lte: 5 } }, { $set: { tier: "pro" } })',
  '',
  'db.users.updateMany({}, { $unset: { phone_number: "" } })',
].join('\n');

describe('the same migration, against a real MongoDB', () => {
  let fixture: MongoFixture;
  let recorded: Recorded;
  let previousUrl: string | undefined;
  let uninstall: () => void;
  let context: { subscriptions: { dispose(): void }[] };

  before(async () => {
    fixture = await startMongo();
    await seedMongo(fixture.db());

    previousUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = fixture.uri;

    const stub = makeVscodeStub();
    recorded = stub.recorded;
    context = stub.context;
    uninstall = installVscode(stub.api);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const extension = require('../extension') as { activate(context: unknown): void };
    extension.activate(stub.context);

    // Not a .sql file. The language is chosen from the engine, not the
    // extension on the filename.
    openEditor(stub.api, makeDocument('/work/migrations/0013_cleanup.js', MIGRATION));
  });

  after(async () => {
    // Everything the extension opened, closed. Without this the database
    // client it is still holding keeps the event loop alive and the file times
    // out after every one of its tests has passed — which reports as a failure
    // with nothing failing in it.
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    uninstall();
    if (previousUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = previousUrl;
    }
    await fixture.stop();
  });

  async function findings(): Promise<Record<string, unknown>[]> {
    await waitForMessage(recorded, 'done', RUN_TIMEOUT);
    return recorded.panels
      .flatMap((panel) => panel.posted)
      .filter((message) => message['type'] === 'finding')
      .map((message) => message['finding'] as Record<string, unknown>);
  }

  it('reads a file that is not SQL at all', { timeout: RUN_TIMEOUT }, async () => {
    // The splitter and the classifier are chosen from the engine. Pointed at
    // MongoDB, `db.users.deleteMany({...})` has to become three statements
    // rather than one unparseable blob.
    await recorded.commands.get('dryrun.preview')!();

    const begin = await waitForMessage(recorded, 'begin');
    const statements = begin['statements'] as { sql: string }[];
    assert.equal(statements.length, 3, `split into ${statements.length}`);
    assert.match(statements[0]!.sql, /^db\.users\.deleteMany/);

    assert.deepEqual(
      recorded.shown.filter((one) => one.kind === 'error'),
      [],
    );
  });

  it('counts the documents a deleteMany would remove', { timeout: RUN_TIMEOUT }, async () => {
    // 67 of the 100, the same two thirds the SQL fixtures have.
    const [remove] = await findings();
    assert.equal(remove!['rowCount'], 67);
    assert.equal(remove!['tableRows'], 100);
  });

  it('counts the documents that really change, not the ones that match', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    // Five documents match `_id <= 5`. One of them, `_id: 3`, is already on the
    // pro tier, so four change. MongoDB reports `modifiedCount` and that is the
    // number here.
    //
    // Postgres answers 5 for the same logical statement, because an UPDATE
    // rewrites every matched row whether or not the value differs. Both are
    // true about their own engine, and this is the one place in the project
    // where the same migration honestly gets two different numbers. It is
    // written down in the README next to the other two things that differ,
    // because a user comparing the two would otherwise read it as a bug.
    const update = (await findings())[1]!;
    assert.equal(update['rowCount'], 4);

    const users = fixture.db().collection<UserDocument>('users');
    assert.equal(await users.countDocuments({ _id: { $lte: 5 } }), 5, 'five matched');
    assert.equal(
      await users.countDocuments({ _id: { $lte: 5 }, tier: 'pro' }),
      1,
      'and one of them was already pro',
    );
  });

  it('treats $unset as what it is: taking a field away', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    // There is no DROP COLUMN here, and `$unset` is the nearest thing. Fifty of
    // the hundred have a phone_number; the other fifty never had the field, and
    // lose nothing.
    const unset = (await findings())[2]!;
    assert.equal(unset['kind'], 'drop_column');

    const said = [unset['headline'], unset['detail']].filter(Boolean).join(' ');
    assert.match(said, /50/, `no count of what is lost in: ${said}`);
    assert.equal(unset['severity'], 'destructive', 'fifty documents lose a value');
  });

  it('left every document exactly as it was', { timeout: RUN_TIMEOUT }, async () => {
    // The transaction is the only thing between a preview and an apply, and on
    // this engine it needs a replica set to exist at all.
    const users = fixture.db().collection<UserDocument>('users');

    assert.equal(await users.countDocuments({}), 100, 'the deleteMany was not rolled back');
    assert.equal(await users.countDocuments({ tier: 'free' }), 67);
    assert.equal(
      await users.countDocuments({ phone_number: { $exists: true } }),
      50,
      'the $unset was not rolled back',
    );
  });

  it('counts a missing field and a null one as the same absence', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    // Six documents hold `email: null` and six have no `email` key at all. Both
    // mean "no value here", and a count that saw only one of the two would be
    // half right in a way nothing on screen would reveal.
    const users = fixture.db().collection<UserDocument>('users');

    assert.equal(await users.countDocuments({ email: null }), 12, 'Mongo counts both as null');
    assert.equal(await users.countDocuments({ email: { $exists: false } }), 6);
    assert.equal(await users.countDocuments({ email: { $exists: true, $ne: null } }), 88);
  });
});
