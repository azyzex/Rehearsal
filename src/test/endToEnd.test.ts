import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PostgresFixture, startPostgres } from './support/pgFixture';
import {
  Recorded,
  installVscode,
  makeDocument,
  makeVscodeStub,
  openEditor,
} from './support/vscodeStub';

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

/**
 * One database, one stub, one activation, for the whole file.
 *
 * The extension module binds its `import * as vscode` the first time it is
 * required and keeps that binding, so a second stub installed later would be
 * ignored and every command would go on registering into the first. Sharing
 * the setup is the only arrangement that is not quietly wrong; `installVscode`
 * now throws rather than letting a second one through.
 */
let fixture: PostgresFixture;
let recorded: Recorded;
let api: ReturnType<typeof makeVscodeStub>['api'];
let uninstall: () => void;
let context: { subscriptions: { dispose(): void }[] };
let previousUrl: string | undefined;

before(async () => {
  fixture = await startPostgres();

  // Where a first-time user's connection comes from, and the only source that
  // needs no workspace and no settings.
  previousUrl = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = fixture.connectionString;

  const stub = makeVscodeStub();
  recorded = stub.recorded;
  api = stub.api;
  context = stub.context;
  uninstall = installVscode(stub.api);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const extension = require('../extension') as { activate(context: unknown): void };
  extension.activate(stub.context);
});

after(async () => {
  // Everything the extension opened, closed. Without this the database client
  // it is still holding keeps the event loop alive and the file times out after
  // every one of its tests has passed — which reports as a failure with nothing
  // failing in it.
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

describe('a command, a real database, and a panel', () => {
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

/**
 * Preview, which is the whole product.
 *
 * A file of four statements against a hundred real rows. Every number below is
 * one the extension had to get by executing the statement and rolling it back —
 * none of them can be reached by reading the SQL.
 *
 * The fixture is built for exactly this: twelve users with no email, a nickname
 * column nothing ever set, and two thirds of the table on the free tier.
 */
describe('previewing a migration against real rows', () => {
  const MIGRATION = [
    "DELETE FROM users WHERE tier = 'free';",
    '',
    'ALTER TABLE users DROP COLUMN nickname;',
    '',
    'ALTER TABLE users ALTER COLUMN email SET NOT NULL;',
    '',
    "UPDATE users SET tier = 'pro' WHERE id <= 5;",
    '',
    'DELETE FROM users;',
  ].join('\n');

  before(() => {
    // The file the user is looking at. Nothing else about the setup changes:
    // the same activation, against the same database.
    openEditor(api, makeDocument('/work/migrations/0011_cleanup.sql', MIGRATION));

    for (const panel of recorded.panels) {
      panel.posted.length = 0;
    }
  });

  /** Every finding the panel was sent, once the run has finished. */
  async function findings(): Promise<Record<string, unknown>[]> {
    await waitForMessage(recorded, 'done', 60_000);
    return recorded.panels
      .flatMap((panel) => panel.posted)
      .filter((message) => message['type'] === 'finding')
      .map((message) => message['finding'] as Record<string, unknown>);
  }

  it('measures all five statements', { timeout: RUN_TIMEOUT }, async () => {
    await recorded.commands.get('dryrun.preview')!();

    const all = await findings();
    assert.equal(all.length, 5, `measured ${all.length} of 5`);
    assert.deepEqual(
      recorded.shown.filter((one) => one.kind === 'error'),
      [],
    );
  });

  it('counts the rows a DELETE would really remove', { timeout: RUN_TIMEOUT }, async () => {
    // 67 of the 100 are on the free tier. Reading the SQL cannot produce that
    // number; running it and rolling it back is the only way to have it.
    const [remove] = await findings();
    assert.equal(remove!['rowCount'], 67);
    assert.equal(remove!['tableRows'], 100);
    assert.match(wording(remove!), /67/, 'and the number is in front of the reader');
  });

  it('measures each statement against the table as it is now', { timeout: RUN_TIMEOUT }, async () => {
    // The fourth statement updates ids 1-5, four of which the first statement
    // would have deleted. It still reports five, which is only true if every
    // statement was rolled back before the next one was measured.
    const all = await findings();
    assert.equal(all[3]!['rowCount'], 5);
    assert.equal(all[0]!['tableRows'], 100);
    assert.equal(all[4]!['tableRows'], 100, 'the last one still sees a full table');
  });

  it('calls a DELETE with no WHERE destructive however few rows it hits', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    // Severity comes from measured numbers, with one exception: no WHERE at all
    // is a different kind of mistake from matching a lot of rows, and is called
    // destructive on its own.
    const all = await findings();
    assert.equal(all[4]!['severity'], 'destructive');
    assert.equal(all[4]!['rowCount'], 100);
  });

  it('stays under caution for a DELETE below the threshold', { timeout: RUN_TIMEOUT }, async () => {
    // 67 rows is under `cautionRowThreshold` (100), so this is `safe` by the
    // rule in spec section 7 — the thresholds are absolute row counts, not
    // proportions, and two thirds of a hundred-row table is not two thirds of a
    // real one. Pinned here because it is the rule most likely to be changed by
    // accident, and because "safe" next to "67 rows deleted" is a wording
    // question worth having on purpose rather than by drift.
    const [remove] = await findings();
    assert.equal(remove!['severity'], 'safe');
  });

  it('calls dropping a column nothing ever filled in safe, and says why', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    const drop = (await findings())[1]!;
    assert.equal(drop['severity'], 'safe');
    assert.match(String(drop['detail']), /null|empty|no data|nothing/i);
  });

  it('finds the twelve rows that stop a NOT NULL', { timeout: RUN_TIMEOUT }, async () => {
    // The statement fails against this data, and saying so before it runs is
    // the entire pitch.
    const notNull = (await findings())[2]!;
    assert.equal(notNull['rowCount'], 12);
    assert.notEqual(notNull['severity'], 'safe');
    assert.match(wording(notNull), /12/, 'and puts the number in front of the reader');
  });

  it('counts an UPDATE exactly, not approximately', { timeout: RUN_TIMEOUT }, async () => {
    const update = (await findings())[3]!;
    assert.equal(update['rowCount'], 5);
  });

  it('changed nothing while measuring', { timeout: RUN_TIMEOUT }, async () => {
    // The one claim that has to hold: everything above ran against the real
    // table, and the table is exactly as it was.
    const { Client } = await import('pg');
    const client = new Client({ connectionString: fixture.connectionString });
    await client.connect();
    try {
      const rows = await client.query('SELECT count(*)::int AS n FROM users');
      assert.equal(rows.rows[0].n, 100, 'the DELETE was not rolled back');

      const nulls = await client.query(
        'SELECT count(*)::int AS n FROM users WHERE email IS NULL',
      );
      assert.equal(nulls.rows[0].n, 12);

      const columns = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'users' ORDER BY ordinal_position`,
      );
      assert.ok(
        columns.rows.some((row: { column_name: string }) => row.column_name === 'nickname'),
        'the DROP COLUMN was not rolled back',
      );
    } finally {
      await client.end();
    }
  });
});

/** The words a finding puts in front of the user. */
function wording(finding: Record<string, unknown>): string {
  return [finding['headline'], finding['detail']].filter(Boolean).join(' ');
}
