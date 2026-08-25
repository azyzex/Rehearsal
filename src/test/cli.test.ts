import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Output, run } from '../cli/index';
import { markdownReport, shouldFail, textReport } from '../cli/report';
import { Finding, Severity } from '../analysis/types';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Dry Run outside the editor.
 *
 * The exit code is the whole feature: a report nobody reads still fails the
 * build, and a build that goes green on a migration that deletes forty thousand
 * rows is worse than having no check at all. So most of these are about which
 * findings turn into a non-zero exit.
 */

function finding(severity: Severity, overrides: Partial<Finding> = {}): Finding {
  return {
    statementIndex: 0,
    kind: 'update',
    classification: { kind: 'update', table: 'users' } as Finding['classification'],
    severity,
    headline: 'Changes rows',
    detail: '12 rows change.',
    ...overrides,
  };
}

describe('what fails a build', () => {
  const findings = [finding('safe'), finding('caution'), finding('blocking')];

  it('fails on destructive by default, and this file has none', () => {
    assert.equal(shouldFail(findings, 'destructive'), false);
  });

  it('fails on the level asked for', () => {
    assert.equal(shouldFail(findings, 'blocking'), true);
    assert.equal(shouldFail(findings, 'caution'), true);
  });

  it('counts anything worse than the level too', () => {
    // Asking to fail on blocking and getting a pass because the only problem
    // was destructive would be the worst possible reading of the flag.
    assert.equal(shouldFail([finding('destructive')], 'blocking'), true);
  });

  it('never fails when asked never to', () => {
    assert.equal(shouldFail([finding('destructive')], 'never'), false);
  });

  it('passes a clean file', () => {
    assert.equal(shouldFail([finding('safe')], 'caution'), false);
  });
});

describe('the text report', () => {
  const input = {
    file: 'migrations/0002.sql',
    connection: 'shop',
    findings: [
      finding('destructive', { headline: 'Will destroy data', detail: '40,072 rows.' }),
      finding('safe', { statementIndex: 1, headline: 'Safe', detail: 'Nothing changes.' }),
    ],
  };

  it('leads with the file and what it was measured against', () => {
    assert.match(textReport(input), /^migrations\/0002\.sql — measured against shop/);
  });

  it('numbers lines the way an editor does', () => {
    assert.match(textReport(input), /line 1 {2}Will destroy data/);
    assert.match(textReport(input), /line 2 {2}Safe/);
  });

  it('ends with the verdict', () => {
    assert.match(textReport(input), /1 would destroy data\. Out of 2 statements\.\n$/);
  });

  it('mentions a lock queue, which changes the decision', () => {
    const report = textReport({
      ...input,
      findings: [
        finding('blocking', {
          queuedBehind: [
            {
              pid: 1,
              state: 'active',
              applicationName: 'reports',
              query: 'SELECT ...',
              seconds: 900,
              lockMode: 'AccessShareLock',
            },
          ],
        }),
      ],
    });
    assert.match(report, /queues behind 1 running session/);
  });

  it('mentions a trigger that escapes the rollback', () => {
    const report = textReport({
      ...input,
      findings: [
        finding('caution', {
          triggers: [
            {
              name: 'announce',
              table: 'users',
              timing: 'after',
              events: ['update'],
              functionName: 'announce',
              enabled: true,
              escapes: ['sends a notification'],
            },
          ],
        }),
      ],
    });
    assert.match(report, /may reach outside the transaction/);
  });

  it('says nothing about triggers that stay inside', () => {
    const report = textReport({
      ...input,
      findings: [
        finding('caution', {
          triggers: [
            {
              name: 'audit',
              table: 'users',
              timing: 'after',
              events: ['update'],
              functionName: 'log',
              enabled: true,
              escapes: [],
            },
          ],
        }),
      ],
    });
    assert.doesNotMatch(report, /outside the transaction/);
  });
});

describe('the markdown report', () => {
  it('builds a table a pull request can render', () => {
    const report = markdownReport({
      file: 'migrations/0002.sql',
      connection: 'shop',
      findings: [finding('destructive', { detail: '40,072 rows.' })],
    });

    assert.match(report, /^## Dry Run/);
    assert.match(report, /\| 🔴 \| 1 \| Changes rows \| 40,072 rows\. \|/);
    assert.match(report, /Nothing was committed/);
  });

  it('escapes a pipe in a measurement so the table survives it', () => {
    // Details are prose, and prose contains punctuation. One unescaped pipe
    // turns the whole table back into text.
    const report = markdownReport({
      file: 'f.sql',
      connection: 'shop',
      findings: [finding('caution', { detail: 'matches a | b' })],
    });
    assert.match(report, /matches a \\\| b/);
  });

  it('flattens a multi-line detail into the cell', () => {
    const report = markdownReport({
      file: 'f.sql',
      connection: 'shop',
      findings: [finding('caution', { detail: 'first line\nsecond line' })],
    });
    assert.match(report, /first line second line/);
  });
});

describe('running it', () => {
  let fixture: PostgresFixture;
  const written: string[] = [];

  const out: string[] = [];
  const err: string[] = [];
  const io: Output = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };

  before(async () => {
    fixture = await startPostgres();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-cli-'));

    const write = (name: string, sql: string): void => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, sql, 'utf8');
      written.push(file);
    };

    write('destructive.sql', 'DELETE FROM users;\n');
    write('safe.sql', `UPDATE users SET tier = 'free' WHERE id = -1;\n`);
  });

  after(async () => {
    await fixture?.stop();
  });

  function captured(): string {
    const text = out.join('');
    out.length = 0;
    return text;
  }

  function errors(): string {
    const text = err.join('');
    err.length = 0;
    return text;
  }

  it('exits 1 on a destructive migration', async () => {
    const code = await run([written[0]!, '--url', fixture.connectionString], io);
    assert.equal(code, 1);
    assert.match(captured(), /DESTRUCTIVE/);
  });

  it('exits 0 on one that changes nothing', async () => {
    const code = await run([written[1]!, '--url', fixture.connectionString], io);
    assert.equal(code, 0);
    assert.match(captured(), /nothing destructive found/);
  });

  it('leaves the data alone', async () => {
    // It just ran DELETE FROM users against a real database and reported on
    // it. If that were not rolled back, this is where it would show.
    const code = await run([written[1]!, '--url', fixture.connectionString], io);
    captured();
    assert.equal(code, 0);

    const { Client } = await import('pg');
    const client = new Client({ connectionString: fixture.connectionString });
    await client.connect();
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM users');
    await client.end();
    assert.equal(rows[0].n, 100, 'every row still there');
  });

  it('honours --fail-on', async () => {
    const code = await run([written[0]!, '--url', fixture.connectionString, '--fail-on', 'never'], io);
    captured();
    assert.equal(code, 0, 'still reported, just not fatal');
  });

  it('writes markdown when asked', async () => {
    await run([written[0]!, '--url', fixture.connectionString, '--format', 'markdown'], io);
    assert.match(captured(), /^## Dry Run/m);
  });

  it('measures several files in one run', async () => {
    const code = await run([written[1]!, written[0]!, '--url', fixture.connectionString], io);
    const text = captured();
    assert.equal(code, 1, 'one clean file does not excuse the other');
    assert.match(text, /safe\.sql/);
    assert.match(text, /destructive\.sql/);
  });

  it('prints usage and exits 0 with no arguments', async () => {
    assert.equal(await run([], io), 0);
    assert.match(captured(), /measure a migration against a real database/);
  });

  it('refuses an unknown option rather than ignoring it', async () => {
    assert.equal(await run([written[0]!, '--apply'], io), 2);
    assert.match(errors(), /Unknown option: --apply/);
  });

  it('says so when there is no connection string', async () => {
    const saved = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      assert.equal(await run([written[0]!], io), 2);
      assert.match(errors(), /Pass --url or set DATABASE_URL/);
    } finally {
      if (saved !== undefined) {
        process.env['DATABASE_URL'] = saved;
      }
    }
  });

  it('says which file it could not find', async () => {
    assert.equal(await run(['nope.sql', '--url', fixture.connectionString], io), 2);
    assert.match(errors(), /No such file: nope\.sql/);
  });

  it('refuses a level it does not know', async () => {
    assert.equal(
      await run([written[0]!, '--url', fixture.connectionString, '--fail-on', 'sometimes'], io),
      2,
    );
    assert.match(errors(), /Unknown level/);
  });

  it('exits 2 rather than 1 when it cannot connect', async () => {
    // A connection failure is not "the migration is dangerous", and a build
    // that cannot tell those apart will eventually be told to ignore both.
    const code = await run([
      written[1]!,
      '--url',
      'postgresql://nobody@127.0.0.1:1/none?connect_timeout=1',
    ], io);
    captured();
    assert.equal(code, 2);
    assert.ok(errors().length > 0);
  });
});
