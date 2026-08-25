import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { previewPanelHtml } from '../../panel/html';
import {
  Panel,
  closeBrowser,
  contrast,
  count,
  openPanel,
  texts,
  visible,
} from '../support/uiHarness';

/**
 * The preview panel, rendered.
 *
 * These exist because of two bugs that every other kind of test in this
 * repository passed cleanly: a drawer that never opened, and a button whose
 * label was the same colour as its background. Both were only ever visible in
 * a browser, and both were found by a person looking at a screenshot and
 * saying "nothing happens".
 *
 * So each of these does what that person did: render the page, click the
 * thing, and check that something happened — and, where a control has been
 * styled, that its text can actually be read.
 */

const BEGIN = {
  type: 'begin',
  file: 'migrations/0002_drop_phone_number.sql',
  connection: 'shop@neon',
  statements: [
    {
      index: 0,
      sql: 'ALTER TABLE users DROP COLUMN phone_number',
      startLine: 0,
      endLine: 0,
    },
    {
      index: 1,
      sql: "UPDATE orders SET status = 'archived' WHERE created_at < now() - interval '1 year'",
      startLine: 2,
      endLine: 2,
    },
  ],
};

/** A destructive finding shaped exactly as the controller serialises one. */
const DROP_FINDING = {
  statementIndex: 0,
  kind: 'drop_column',
  classification: { kind: 'drop_column', table: 'users', column: 'phone_number' },
  severity: 'destructive',
  headline: 'Will destroy data',
  detail: '40,072 rows have a value in phone_number. Dropping it cannot be undone.',
  rowCount: 40_072,
  tableRows: 50_000,
};

const UPDATE_FINDING = {
  statementIndex: 1,
  kind: 'update',
  classification: { kind: 'update', table: 'orders' },
  severity: 'caution',
  headline: 'Changes 1,927 rows',
  detail: '1,927 of 300,000 rows in orders change.',
  rowCount: 1927,
  tableRows: 300_000,
};

describe('the preview panel, rendered', () => {
  let panel: Panel;

  before(async () => {
    panel = await openPanel(previewPanelHtml);
    await panel.send(BEGIN);
    await panel.send({ type: 'finding', finding: DROP_FINDING });
    await panel.send({ type: 'finding', finding: UPDATE_FINDING });
    await panel.send({ type: 'done', summary: '1 would destroy data. Out of 2 statements.' });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  it('loads without a script throwing', () => {
    // The failure this catches is total and silent: one thrown line and the
    // whole panel is inert while looking perfectly normal.
    assert.deepEqual(panel.problems, []);
  });

  it('draws a row per statement, with the file and connection', async () => {
    assert.equal(await count(panel.page, '.row'), 2);
    assert.equal(await panel.page.textContent('#file'), BEGIN.file);
    assert.equal(await panel.page.textContent('#connection'), 'shop@neon');
  });

  it('shows the measurement, not just the verdict', async () => {
    const detail = await panel.page.textContent('.row.destructive .detail');
    assert.match(detail ?? '', /40,072 rows have a value in phone_number/);
  });

  it('draws the blast radius to scale', async () => {
    // 40,072 of 50,000 is most of the table, and the bar has to say so
    // without anyone reading a number.
    const width = await panel.page.evaluate(`
      (function () {
        var fill = document.querySelector('.row.destructive .radius-fill');
        if (!fill) { return null; }
        var track = fill.parentElement;
        return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
      })()
    `);
    assert.ok(typeof width === 'number', 'the bar is drawn at all');
    assert.ok(width > 0.7 && width <= 1, `bar covers ${width} of the track`);
  });

  it('every row is readable', async () => {
    for (const selector of ['.row.destructive .badge', '.row.caution .badge', '#summary']) {
      const ratio = await contrast(panel.page, selector);
      assert.ok(ratio >= 3, `${selector} has contrast ${ratio.toFixed(2)}`);
    }
  });

  it('the summary says what was found', async () => {
    assert.equal(await visible(panel.page, '#summary'), true);
    assert.match(
      (await panel.page.textContent('#summary')) ?? '',
      /1 would destroy data\. Out of 2 statements\./,
    );
  });

  describe('the offending rows', () => {
    it('offers to fetch them on a statement that removes something', async () => {
      const buttons = await texts(panel.page, '.offenders button');
      assert.deepEqual(buttons, ['Show me which rows']);
    });

    it('asks the extension when clicked, rather than doing nothing', async () => {
      // This is the drawer bug's exact shape: a button that renders, takes the
      // click, and never tells anyone.
      await panel.click('.offenders button');
      const posted = await panel.posted();
      assert.ok(
        posted.some(
          (message) =>
            (message as { type?: string }).type === 'showOffenders' &&
            (message as { index?: number }).index === 0,
        ),
        `nothing asked for the rows. Posted: ${JSON.stringify(posted)}`,
      );
    });

    it('renders the rows and marks the column at issue', async () => {
      await panel.send({
        type: 'offenders',
        statementIndex: 0,
        offenders: {
          kind: 'null',
          table: 'users',
          column: 'phone_number',
          total: 40_072,
          rows: [
            { id: '1', email: 'a@example.com', phone_number: '+15550001' },
            { id: '2', email: 'b@example.com', phone_number: '+15550002' },
          ],
          fix: {
            title: 'Back it up first',
            sql: 'CREATE TABLE users_phone_backup AS SELECT id, phone_number FROM users',
            needsEditing: false,
            note: 'Keeps the values somewhere the drop cannot reach.',
          },
        },
      });

      assert.equal(await count(panel.page, '.offenders .sample tbody tr'), 2);
      assert.equal(
        await count(panel.page, '.offenders td.offending'),
        2,
        'the column that put each row in the list is marked',
      );
      assert.match(
        (await panel.page.textContent('.offenders-head')) ?? '',
        /40,072 rows in users\.phone_number/,
      );
      assert.match((await panel.page.textContent('.offenders-more')) ?? '', /Showing 2 of/);
    });

    it('renders the fix with buttons you can read', async () => {
      const buttons = await texts(panel.page, '.offenders .rewrite-actions button');
      assert.deepEqual(buttons, ['Copy', 'Insert above the statement']);

      // The bug that made this test worth writing: `mini` is a class schema.css
      // defines and panel.css does not, so these rendered as bare browser
      // defaults until the class was corrected to `tiny`.
      for (const nth of [1, 2]) {
        const selector = `.offenders .rewrite-actions button:nth-of-type(${nth})`;
        assert.equal(await visible(panel.page, selector), true);
        const ratio = await contrast(panel.page, selector);
        assert.ok(ratio >= 3, `fix button ${nth} has contrast ${ratio.toFixed(2)}`);
      }
    });

    it('inserts the fix above the statement rather than replacing it', async () => {
      await panel.click('.offenders .rewrite-actions button:nth-of-type(2)');
      const posted = (await panel.posted()) as { type?: string; statements?: string[] }[];
      const insert = posted.find((message) => message.type === 'applyRewrite');

      assert.ok(insert, 'nothing was posted');
      assert.equal(insert!.statements?.length, 2);
      assert.match(insert!.statements![0]!, /CREATE TABLE users_phone_backup/);
      assert.match(insert!.statements![1]!, /DROP COLUMN phone_number/);
    });
  });

  describe('where the code uses it', () => {
    it('offers the search, and asks for it when clicked', async () => {
      assert.equal(await visible(panel.page, '.refs button'), true);
      await panel.click('.refs button');

      const posted = (await panel.posted()) as { type?: string; index?: number }[];
      assert.ok(posted.some((message) => message.type === 'showReferences' && message.index === 0));
    });

    it('lists the places it found, file and line first', async () => {
      await panel.send({
        type: 'references',
        statementIndex: 0,
        scan: {
          summary: '3 mentions of users.phone_number in 2 files. Searched as phone_number, phoneNumber.',
          total: 3,
          references: [
            { file: 'src/user.ts', line: 42, text: 'const n = user.phoneNumber;', form: 'phoneNumber' },
            { file: 'src/user.ts', line: 88, text: 'phoneNumber: true,', form: 'phoneNumber' },
            { file: 'sql/report.sql', line: 3, text: 'SELECT phone_number FROM users', form: 'phone_number' },
          ],
        },
      });

      assert.equal(await count(panel.page, '.refs .ref'), 3);
      assert.deepEqual((await texts(panel.page, '.refs .ref-where')).slice(0, 2), [
        'src/user.ts:42',
        'src/user.ts:88',
      ]);
    });

    it('makes a found reference stand out from a clean one', async () => {
      const ratio = await contrast(panel.page, '.refs-head.found');
      assert.ok(ratio >= 3, `the headline has contrast ${ratio.toFixed(2)}`);
    });
  });

  describe('a trigger that escapes the rollback', () => {
    before(async () => {
      await panel.send({
        type: 'finding',
        finding: {
          ...UPDATE_FINDING,
          triggers: [
            {
              name: 'orders_announce',
              table: 'orders',
              timing: 'after',
              events: ['update'],
              functionName: 'announce',
              enabled: true,
              escapes: ['sends a notification (pg_notify / NOTIFY)'],
            },
          ],
        },
      });
    });

    it('is drawn in the loud style, not the quiet one', async () => {
      assert.equal(await visible(panel.page, '.triggers.escaping'), true);
      assert.match(
        (await panel.page.textContent('.triggers.escaping .triggers-head')) ?? '',
        /may reach outside the transaction/,
      );
    });

    it('names the trigger and what it does', async () => {
      assert.equal(await panel.page.textContent('.trigger-name'), 'orders_announce');
      assert.match((await panel.page.textContent('.trigger-escape')) ?? '', /pg_notify/);
    });

    it('is readable, which is the whole point of making it loud', async () => {
      for (const selector of ['.triggers.escaping .triggers-head', '.trigger-escape']) {
        const ratio = await contrast(panel.page, selector);
        assert.ok(ratio >= 3, `${selector} has contrast ${ratio.toFixed(2)}`);
      }
    });

    it('says one level deep is not a proof', async () => {
      const notes = await texts(panel.page, '.triggers.escaping .triggers-note');
      assert.ok(
        notes.some((note) => /not a promise/.test(note)),
        'an empty escape list is the easiest thing here to mistake for a guarantee',
      );
    });
  });

  it('nothing threw at any point', () => {
    assert.deepEqual(panel.problems, []);
  });

  it('looks like this', async () => {
    // Not an assertion. The file is the artefact: it is how a change to any of
    // this gets looked at rather than only reasoned about.
    await panel.shot('preview-panel');
  });
});
