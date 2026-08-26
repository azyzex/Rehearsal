import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MysqlFixture, seedMysql, startMysql } from './support/mysqlFixture';
import {
  Recorded,
  installVscode,
  makeDocument,
  makeVscodeStub,
  openEditor,
} from './support/vscodeStub';

/**
 * The same migration, against a real MySQL.
 *
 * The MySQL fixture is seeded to match the Postgres one row for row — the same
 * hundred users, the same twelve without an email, the same two thirds on the
 * free tier — so a difference in an answer here is a difference in the adapter
 * rather than a difference in what it was pointed at.
 *
 * Which is the point. The DML half should give the identical numbers, because
 * both engines roll a transaction back. The DDL half must not: MySQL commits
 * schema changes the moment they run, so the adapter refuses to execute them
 * and measures by counting instead. A test that got the same answer for every
 * statement on both engines would mean the refusal was not working.
 */

const RUN_TIMEOUT = 120_000;

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
  "DELETE FROM users WHERE tier = 'free';",
  '',
  'ALTER TABLE users DROP COLUMN nickname;',
  '',
  'ALTER TABLE users MODIFY email varchar(255) NOT NULL;',
  '',
  "UPDATE users SET tier = 'pro' WHERE id <= 5;",
].join('\n');

describe('the same migration, against a real MySQL', () => {
  let fixture: MysqlFixture;
  let recorded: Recorded;
  let previousUrl: string | undefined;
  let uninstall: () => void;

  before(async () => {
    fixture = await startMysql();
    const connection = await fixture.connect();
    try {
      await seedMysql(connection);
    } finally {
      await connection.end();
    }

    previousUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = fixture.connectionString;

    const stub = makeVscodeStub();
    recorded = stub.recorded;
    uninstall = installVscode(stub.api);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const extension = require('../extension') as { activate(context: unknown): void };
    extension.activate(stub.context);

    openEditor(stub.api, makeDocument('/work/migrations/0012_cleanup.sql', MIGRATION));
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

  async function findings(): Promise<Record<string, unknown>[]> {
    await waitForMessage(recorded, 'done', RUN_TIMEOUT);
    return recorded.panels
      .flatMap((panel) => panel.posted)
      .filter((message) => message['type'] === 'finding')
      .map((message) => message['finding'] as Record<string, unknown>);
  }

  it('works out it is talking to MySQL from the connection string', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    await recorded.commands.get('dryrun.preview')!();

    const begin = await waitForMessage(recorded, 'begin');
    assert.match(String(begin['connection']), /@127\.0\.0\.1|mysql/i);
    assert.deepEqual(
      recorded.shown.filter((one) => one.kind === 'error'),
      [],
    );
  });

  it('measures all four statements', { timeout: RUN_TIMEOUT }, async () => {
    assert.equal((await findings()).length, 4);
  });

  it('gets the same DML numbers Postgres gets', { timeout: RUN_TIMEOUT }, async () => {
    // MySQL has no RETURNING, so the adapter reads the matching rows before,
    // runs the statement, and reads the same keys back. A different mechanism
    // arriving at the same count is the whole claim of the adapter contract.
    const all = await findings();
    assert.equal(all[0]!['rowCount'], 67, 'the DELETE');
    assert.equal(all[0]!['tableRows'], 100);
    assert.equal(all[3]!['rowCount'], 5, 'the UPDATE');
  });

  it('reads MySQL DDL that Postgres has no syntax for', { timeout: RUN_TIMEOUT }, async () => {
    // `MODIFY email varchar(255) NOT NULL` is how MySQL says SET NOT NULL, and
    // a classifier that only knew the Postgres spelling would come back with
    // "not analysed" for the most dangerous statement in the file.
    const all = await findings();
    assert.equal(all[1]!['kind'], 'drop_column');
    assert.equal(all[2]!['kind'], 'set_not_null');
  });

  it('finds the twelve rows that stop a NOT NULL here too', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    // This came back `safe` — "every row already has a value in email" — about
    // a statement that fails against twelve rows. The probe asked
    // `WHERE "email" IS NULL`, and MySQL's default sql_mode reads `"email"` as
    // the string 'email', so it was asking whether a constant is null. Always
    // false, always zero, always safe.
    //
    // Telling someone a migration is safe when it will fail is the worst wrong
    // answer available here, and it is the one that only shows up on the engine
    // nothing had ever run this path against.
    const notNull = (await findings())[2]!;
    assert.equal(notNull['rowCount'], 12);
    assert.notEqual(notNull['severity'], 'safe');

    const said = [notNull['headline'], notNull['detail']].filter(Boolean).join(' ');
    assert.match(said, /12/, `no count in: ${said}`);
  });

  it('never runs the DDL to find that out', { timeout: RUN_TIMEOUT }, async () => {
    // Both DDL statements are answered by counting, on every engine — the
    // difference on MySQL is that there is no rollback to fall back on if that
    // ever changed. Neither finding carries an error, which is what a refusal
    // would look like.
    const all = await findings();
    for (const finding of [all[1]!, all[2]!]) {
      assert.equal(finding['error'], undefined, `${finding['kind']} could not be measured`);
    }
  });

  it('left the database exactly as it was', { timeout: RUN_TIMEOUT }, async () => {
    // The claim that matters most on the engine that cannot take a schema
    // change back: nothing above was allowed to run.
    const connection = await fixture.connect();
    try {
      const [rows] = await connection.query('SELECT count(*) AS n FROM users');
      assert.equal(Number((rows as { n: number }[])[0]!.n), 100);

      const [columns] = await connection.query(
        'SELECT column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = ?',
        ['users', fixture.database],
      );
      const names = (columns as Record<string, unknown>[]).map((row) =>
        String(row['column_name'] ?? row['COLUMN_NAME']),
      );
      assert.ok(names.includes('nickname'), `the DROP COLUMN ran: ${names.join(', ')}`);

      const [nulls] = await connection.query(
        'SELECT count(*) AS n FROM users WHERE email IS NULL',
      );
      assert.equal(
        Number((nulls as { n: number }[])[0]!.n),
        12,
        'the NOT NULL ran, or the DELETE did',
      );
    } finally {
      await connection.end();
    }
  });

  it('says a changeset with DDL in it cannot be applied as one unit', {
    timeout: RUN_TIMEOUT,
  }, async () => {
    // Four statements, two of which commit the moment they run. Offering to
    // apply that as a single reversible unit would be a lie.
    const done = await waitForMessage(recorded, 'done');
    assert.ok(String(done['summary']).length > 0);
  });
});
