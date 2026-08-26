import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { previewPanelHtml, schemaPanelHtml, sidebarHtml } from '../../panel/html';
import { Panel, closeBrowser, count, openPanel, visible } from '../support/uiHarness';

/**
 * Every control, pressed.
 *
 * A button whose listener was never attached posts nothing, and nothing
 * anywhere says so: the contract test proves that every message *sent* has
 * someone listening, but a button that sends no message at all is invisible to
 * it. Pressing it is the only way to find out.
 *
 * Thirteen of the twenty-four controls in the markup had never been pressed by
 * any test, including Preview — the one the whole extension is named after.
 *
 * The assertion is deliberately shallow. What each command does on the far side
 * is tested elsewhere; the question here is only whether the press leaves the
 * page at all.
 */

const column = (name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  isPrimaryKey: false,
  ...extra,
});

const SNAPSHOT = {
  schemas: ['public', 'reporting'],
  tables: [
    {
      schema: 'public',
      name: 'users',
      qualified: 'users',
      rows: 50_000,
      bytes: 12_000_000,
      partitioned: false,
      columns: [
        column('id', 'integer', { isPrimaryKey: true, nullable: false }),
        column('email'),
      ],
    },
    {
      schema: 'public',
      name: 'orders',
      qualified: 'orders',
      rows: 300_000,
      bytes: 90_000_000,
      partitioned: false,
      columns: [
        column('id', 'integer', { isPrimaryKey: true, nullable: false }),
        column('user_id', 'integer', { nullable: false }),
      ],
    },
    {
      schema: 'reporting',
      name: 'daily_totals',
      qualified: 'reporting.daily_totals',
      rows: 900,
      bytes: 200_000,
      partitioned: false,
      columns: [column('day', 'date', { nullable: false }), column('cents', 'integer')],
    },
  ],
  foreignKeys: [
    {
      name: 'orders_user_id_fkey',
      fromTable: 'orders',
      fromColumns: ['user_id'],
      toTable: 'users',
      toColumns: ['id'],
    },
  ],
};

const EMPTY_DIFF = { tables: [], columns: [], relationships: [], dataEdits: 0 };

const CHANGES = [
  { index: 0, label: 'Drop column email from users', sql: 'ALTER TABLE users DROP COLUMN email' },
];

/** The message types posted since the panel opened. */
async function sent(panel: Panel): Promise<string[]> {
  const posted = (await panel.posted()) as { type?: string }[];
  return posted.map((message) => message.type ?? '');
}

/** Presses one control and returns the message type it produced, if any. */
async function press(panel: Panel, selector: string, expected: string): Promise<void> {
  const before = (await sent(panel)).filter((type) => type === expected).length;
  await panel.click(selector);
  const after = (await sent(panel)).filter((type) => type === expected).length;

  assert.ok(
    after > before,
    `pressing ${selector} sent no ${expected} — its listener is not attached`,
  );
  assert.deepEqual(panel.problems, [], `pressing ${selector} threw`);
}

describe('every control, pressed', () => {
  after(async () => {
    await closeBrowser();
  });

  describe('the schema explorer toolbar', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
      await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
    });

    after(async () => {
      await panel.close();
    });

    it('asks for a new table', async () => {
      await press(panel, '#new-table', 'newTable');
    });

    it('asks for a Mermaid export', async () => {
      await press(panel, '#export-diagram', 'exportDiagram');
    });

    it('fits the diagram without throwing', async () => {
      // Fit is entirely local — it posts nothing — so the only thing worth
      // asserting is that pressing it does not break the page and the cards
      // are still on it afterwards.
      await panel.click('#fit');
      await panel.page.waitForTimeout(60);

      assert.deepEqual(panel.problems, []);
      assert.equal(await count(panel.page, '.table'), 3);
    });

    it('narrows to one schema, and back', async () => {
      await panel.page.selectOption('#schema-filter', 'reporting');
      await panel.page.waitForTimeout(60);
      assert.equal(await count(panel.page, '.table'), 1, 'only the reporting table');

      await panel.page.selectOption('#schema-filter', '');
      await panel.page.waitForTimeout(60);
      assert.equal(await count(panel.page, '.table'), 3);
      assert.deepEqual(panel.problems, []);
    });

    it('focuses on what is near one table, and back', async () => {
      // Focus mode is what the crowding hint points at, so it had better work.
      await panel.click('.table[data-table="users"]');
      await panel.page.waitForTimeout(60);
      await panel.page.selectOption('#focus', '1');
      await panel.page.waitForTimeout(60);

      const near = await count(panel.page, '.table');
      assert.ok(near < 3, `focus at depth 1 still shows ${near} of 3 tables`);
      assert.ok(near >= 2, 'users and the table pointing at it');

      await panel.page.selectOption('#focus', '0');
      await panel.page.waitForTimeout(60);
      assert.equal(await count(panel.page, '.table'), 3);
      assert.deepEqual(panel.problems, []);
    });
  });

  describe('the pending-changes buttons', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
      await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
      await panel.send({
        type: 'changeset',
        changes: CHANGES,
        diff: EMPTY_DIFF,
        projected: SNAPSHOT,
        sql: 'ALTER TABLE users DROP COLUMN email;',
      });
    });

    after(async () => {
      await panel.close();
    });

    it('asks for a preview — the button the extension is named after', async () => {
      await press(panel, '#preview', 'previewChanges');
    });

    it('asks for the SQL', async () => {
      await press(panel, '#export', 'exportSql');
    });

    it('asks for the migration that undoes it', async () => {
      await press(panel, '#export-down', 'exportDown');
    });

    it('discards them', async () => {
      await press(panel, '#discard', 'clearEdits');
    });

    it('offers none of those on a changeset it does not own', async () => {
      // A file's changes belong to whatever migration tool wrote it, so the
      // buttons that would rewrite them are not offered at all.
      await panel.send({
        type: 'changeset',
        changes: CHANGES,
        diff: EMPTY_DIFF,
        projected: SNAPSHOT,
        sql: '',
        readOnly: true,
        source: 'migrations/0007_drop.sql',
      });

      for (const selector of ['#preview', '#discard', '#export', '#export-down']) {
        assert.equal(await visible(panel.page, selector), false, `${selector} is still offered`);
      }
    });
  });

  describe('the sidebar', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(sidebarHtml, { width: 300, height: 820 });
      await panel.send({ type: 'state', connected: null, saved: [] });
    });

    after(async () => {
      await panel.close();
    });

    it('asks to pick a .env file', async () => {
      await press(panel, '#from-env', 'pickEnvFile');
    });

    it('sends whether to remember the connection, both ways', async () => {
      // Ticked by default: the string goes to the OS keychain, which is where
      // it should be if it is anywhere, and retyping a Neon URL every session
      // is how people end up pasting it into settings instead. Unticking has
      // to actually work, though, or the choice is decoration.
      await panel.page.fill('#connection', 'postgresql://user:pw@db.example.com/shop');
      assert.equal(await panel.page.isChecked('#remember'), true);

      await panel.click('#go');
      const first = (await panel.posted()) as { type?: string; remember?: boolean }[];
      assert.equal(first.filter((message) => message.type === 'connect').pop()?.remember, true);

      await panel.page.uncheck('#remember');
      await panel.click('#go');
      const second = (await panel.posted()) as { type?: string; remember?: boolean }[];
      assert.equal(
        second.filter((message) => message.type === 'connect').pop()?.remember,
        false,
        'unticking it is ignored, so the box is decoration',
      );
    });

    it('disconnects', async () => {
      await panel.send({
        type: 'state',
        connected: {
          label: 'shop on db.example.com',
          engine: 'postgres',
          engineName: 'PostgreSQL',
          source: 'chosen in the sidebar',
          transactionalDdl: true,
        },
        saved: [],
      });

      await press(panel, '#disconnect', 'disconnect');
    });

    it('runs each action in the connected panel', async () => {
      // Seven buttons, each carrying a command id. One with no listener is a
      // menu entry that does nothing.
      const commands = (await panel.page.evaluate(`
        Array.prototype.map.call(
          document.querySelectorAll('.action'),
          function (button) { return button.dataset.command; }
        )
      `)) as string[];

      assert.ok(commands.length >= 5, `only ${commands.length} actions`);

      for (const command of commands) {
        await panel.click(`.action[data-command="${command}"]`);
      }

      const run = ((await panel.posted()) as { type?: string; command?: string }[])
        .filter((message) => message.type === 'run')
        .map((message) => message.command);

      assert.deepEqual(
        commands.filter((command) => !run.includes(command)),
        [],
        'these buttons sent nothing',
      );
      assert.deepEqual(panel.problems, []);
    });
  });

  describe('the preview panel', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(previewPanelHtml, { width: 900, height: 800 });
      await panel.send({
        type: 'begin',
        file: 'migrations/0010.sql',
        connection: 'shop@neon',
        statements: [{ index: 0, sql: 'DELETE FROM carts', startLine: 0, endLine: 0 }],
      });
    });

    after(async () => {
      await panel.close();
    });

    it('cancels a run in progress, and stops offering to', async () => {
      // The one control here that matters while something is still happening.
      // Leaving it live invites a second cancel of a run already stopping.
      assert.equal(await visible(panel.page, '#cancel'), true, 'offered while measuring');

      await press(panel, '#cancel', 'cancel');

      assert.equal(
        await panel.page.getAttribute('#cancel', 'disabled'),
        '',
        'and goes dead rather than inviting a second press',
      );
    });
  });
});
