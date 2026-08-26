import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PostgresFixture, startPostgres } from './support/pgFixture';
import { Recorded, installVscode, makeVscodeStub } from './support/vscodeStub';

/**
 * A real database, through the extension, into a panel.
 *
 * Every adapter is tested against a real server and every panel is rendered in
 * a browser, and until this nothing joined the two: no test ran a command,
 * against a database, and looked at what arrived at the webview. That gap is
 * where "it says connected but the actions do nothing" lives — the last item
 * on the manual list that could be automated at all.
 *
 * The connection comes from `DATABASE_URL`, which is where a first-time user's
 * connection comes from too.
 */

const RUN_TIMEOUT = 60_000;

/** Waits for a message of this type to arrive at a panel, or gives up. */
async function waitForMessage(
  recorded: Recorded,
  type: string,
  timeoutMs = 20_000,
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

describe('a command, a real database, and a panel', () => {
  let fixture: PostgresFixture;
  let recorded: Recorded;
  let uninstall: () => void;
  let previousUrl: string | undefined;

  before(async () => {
    fixture = await startPostgres();

    // Where a first-time user's connection comes from, and the only source
    // that needs no workspace and no settings.
    previousUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = fixture.connectionString;

    const stub = makeVscodeStub();
    recorded = stub.recorded;
    uninstall = installVscode(stub.api);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const extension = require('../extension') as { activate(context: unknown): void };
    extension.activate(stub.context);
  });

  after(async () => {
    uninstall();
    if (previousUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = previousUrl;
    }
    await fixture.stop();
  });

  it(
    'draws the schema of the database it is pointed at',
    { timeout: RUN_TIMEOUT },
    async () => {
      await recorded.commands.get('dryrun.exploreSchema')!();

      const message = await waitForMessage(recorded, 'schema');
      const snapshot = message['snapshot'] as {
        tables: { name: string; columns: { name: string }[] }[];
        foreignKeys: { fromTable: string; toTable: string }[];
      };

      const names = snapshot.tables.map((table) => table.name).sort();
      assert.deepEqual(names, ['orgs', 'users'], 'the fixture has exactly these two');

      // Read out of the real catalogue, not out of anything this test wrote.
      const users = snapshot.tables.find((table) => table.name === 'users')!;
      assert.deepEqual(
        users.columns.map((column) => column.name),
        ['id', 'email', 'tier', 'phone_number', 'nickname', 'org_id'],
        'in the order the catalogue returns them',
      );

      // The fixture has `users.org_id` pointing at nothing on purpose — it is
      // what the orphan-row check is measured against — so the honest answer
      // here is no relationships at all, not an inferred one.
      assert.deepEqual(snapshot.foreignKeys, []);
    },
  );

  it('says nothing went wrong on the way', () => {
    const errors = recorded.shown.filter((one) => one.kind === 'error');
    assert.deepEqual(errors, []);
  });

  it(
    'writes a health report about the real statistics',
    { timeout: RUN_TIMEOUT },
    async () => {
      // A markdown document rather than a panel, so it is read from the other
      // half of the stub.
      const before = recorded.documents.length;
      await recorded.commands.get('dryrun.schemaHealth')!();

      assert.ok(recorded.documents.length > before, 'no report was opened');
      const report = recorded.documents[recorded.documents.length - 1]!;

      assert.equal(report.language, 'markdown');
      assert.match(report.content, /# Schema health/);
      assert.match(report.content, /dryrun_test/, 'and says which database it read');

      // The fixture is a healthy two-table schema, so the right answer is that
      // there is nothing to say — said out loud, rather than as a blank page.
      assert.match(report.content, /Nothing found/);

      // The statistics are seconds old because the fixture was just created,
      // and the report has to refuse to call an index unused on that basis.
      assert.match(report.content, /not long enough to call an index unused/);

      assert.match(
        report.content,
        /read from the database, not inferred from the schema/,
        'the claim the whole extension rests on',
      );
    },
  );

  it(
    'connects, and then disconnects, without complaining about either',
    { timeout: RUN_TIMEOUT },
    async () => {
      const before = recorded.shown.filter((one) => one.kind === 'error').length;

      await recorded.commands.get('dryrun.testConnection')!();
      await recorded.commands.get('dryrun.disconnect')!();

      const errors = recorded.shown.filter((one) => one.kind === 'error');
      assert.equal(errors.length, before, `${errors.map((one) => one.message).join(' | ')}`);
    },
  );

  it(
    'reconnects for the next command after being disconnected',
    { timeout: RUN_TIMEOUT },
    async () => {
      // Disconnect closes the pool. A command run afterwards has to open a new
      // one rather than failing on the closed one, which is the state anyone
      // who presses Disconnect and then changes their mind is in.
      for (const panel of recorded.panels) {
        panel.posted.length = 0;
      }

      await recorded.commands.get('dryrun.exploreSchema')!();
      const message = await waitForMessage(recorded, 'schema');

      assert.ok((message['snapshot'] as { tables: unknown[] }).tables.length > 0);
    },
  );
});
