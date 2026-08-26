import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { schemaPanelHtml } from '../../panel/html';
import { Panel, closeBrowser, openPanel } from '../support/uiHarness';

/**
 * The visual editor's own buttons.
 *
 * These are the ones that change the database. They live in the drawer, they
 * are built at render time rather than declared in the markup, and every one of
 * them asks a question through `window.prompt` first — which is why none had
 * ever been pressed by a test: Playwright dismisses a dialog nobody handles, so
 * a naive click looks exactly like a cancel and passes whatever it does.
 *
 * The cancel path is tested alongside every confirm path, because the two
 * mistakes are not symmetrical. A rename that does not happen is an annoyance.
 * A drop that happens after someone pressed escape is the worst thing this
 * extension could possibly do.
 */

const column = (name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  isPrimaryKey: false,
  ...extra,
});

const COLUMNS = [
  column('id', 'integer', { isPrimaryKey: true, nullable: false }),
  column('email'),
  column('phone_number'),
];

const SNAPSHOT = {
  schemas: ['public'],
  tables: [
    {
      schema: 'public',
      name: 'users',
      qualified: 'users',
      rows: 50_000,
      bytes: 12_000_000,
      partitioned: false,
      columns: COLUMNS,
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

const DETAIL = {
  table: 'users',
  rows: 50_000,
  rowsEstimated: false,
  primaryKey: ['id'],
  columns: COLUMNS,
  indexes: [],
  constraints: [],
  sample: [],
  sampleRaw: [],
};

type Edit = { kind?: string; table?: string; column?: string; to?: string };

describe('the visual editor, using its own buttons', () => {
  let panel: Panel;

  /**
   * Answers the next dialog with `answer`, or dismisses it when null.
   *
   * Returns what the dialog actually said, because the wording is half of what
   * makes a confirmation a confirmation.
   */
  function answerNextDialog(answer: string | null): Promise<string> {
    return new Promise((resolve) => {
      panel.page.once('dialog', (dialog) => {
        const message = dialog.message();
        void (answer === null ? dialog.dismiss() : dialog.accept(answer)).then(() =>
          resolve(message),
        );
      });
    });
  }

  /** The edits posted since the panel opened. */
  async function edits(): Promise<Edit[]> {
    const posted = (await panel.posted()) as { type?: string; edit?: Edit }[];
    return posted.filter((message) => message.type === 'addEdit').map((message) => message.edit!);
  }

  /** Presses the drawer button with this label. */
  async function pressLabelled(label: string): Promise<void> {
    await panel.page.click(`#drawer button:text-is("${label}")`);
  }

  before(async () => {
    panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
    await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
  });

  beforeEach(async () => {
    await panel.send({ type: 'tableDetail', detail: DETAIL });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  describe('renaming a table', () => {
    it('asks, and sends the new name', async () => {
      const asked = answerNextDialog('people');
      await pressLabelled('Rename table');
      assert.match(await asked, /Rename users to/);

      const rename = (await edits()).filter((edit) => edit.kind === 'rename_table');
      assert.equal(rename.length, 1);
      assert.deepEqual(rename[0], { kind: 'rename_table', table: 'users', to: 'people' });
    });

    it('sends nothing when the question is cancelled', async () => {
      const before = (await edits()).length;
      const asked = answerNextDialog(null);
      await pressLabelled('Rename table');
      await asked;

      assert.equal((await edits()).length, before);
      assert.deepEqual(panel.problems, []);
    });

    it('sends nothing for a name that is only whitespace', async () => {
      // An empty name would produce `ALTER TABLE users RENAME TO ""`.
      const before = (await edits()).length;
      const asked = answerNextDialog('   ');
      await pressLabelled('Rename table');
      await asked;

      assert.equal((await edits()).length, before);
    });

    it('sends nothing when the name is unchanged', async () => {
      // A rename to the same name is a no-op the user would have to notice and
      // remove from the changeset by hand.
      const before = (await edits()).length;
      const asked = answerNextDialog('users');
      await pressLabelled('Rename table');
      await asked;

      assert.equal((await edits()).length, before);
    });
  });

  describe('renaming a column', () => {
    it('asks, and sends the new name against the right column', async () => {
      const asked = answerNextDialog('phone');
      await panel.page.click(
        '#drawer .drawer-col:has-text("phone_number") button:text-is("Rename")',
      );
      assert.match(await asked, /Rename phone_number to/);

      const rename = (await edits()).filter((edit) => edit.kind === 'rename_column');
      assert.equal(rename.length, 1);
      assert.deepEqual(rename[0], {
        kind: 'rename_column',
        table: 'users',
        column: 'phone_number',
        to: 'phone',
      });
    });

    it('sends nothing when cancelled', async () => {
      const before = (await edits()).length;
      const asked = answerNextDialog(null);
      await panel.page.click('#drawer .drawer-col:has-text("email") button:text-is("Rename")');
      await asked;

      assert.equal((await edits()).length, before);
    });
  });

  describe('dropping a table', () => {
    it('will not do it on one press', async () => {
      // The single most destructive thing available here. A button that does it
      // on one click is a button someone eventually hits by accident.
      const before = (await edits()).length;
      const asked = answerNextDialog(null);
      await pressLabelled('Drop table');

      const message = await asked;
      assert.match(message, /Drop users/);
      assert.match(message, /50,000 rows/, 'and says how many rows that is');
      assert.match(message, /Type the table name/);

      assert.equal((await edits()).length, before);
    });

    it('refuses a confirmation that is not the table name', async () => {
      // Typing "yes" is the reflex the confirmation exists to defeat.
      const before = (await edits()).length;
      const asked = answerNextDialog('yes');
      await pressLabelled('Drop table');
      await asked;

      assert.equal((await edits()).length, before, 'a wrong answer dropped the table');
    });

    it('does it when the name is typed exactly', async () => {
      const asked = answerNextDialog('users');
      await pressLabelled('Drop table');
      await asked;

      const drops = (await edits()).filter((edit) => edit.kind === 'drop_table');
      assert.equal(drops.length, 1);
      assert.deepEqual(drops[0], { kind: 'drop_table', table: 'users' });
    });
  });

  describe('showing a table on the diagram', () => {
    it('says so when the table is not currently drawn, rather than doing nothing', async () => {
      // Focus mode or a schema filter can have hidden it entirely, and a button
      // that silently does nothing reads as a broken button.
      await panel.send({ type: 'tableDetail', detail: { ...DETAIL, table: 'not_drawn' } });

      const asked = answerNextDialog('');
      await pressLabelled('Show on diagram');

      assert.match(await asked, /not currently drawn/);
      assert.deepEqual(panel.problems, []);
    });

    it('says nothing at all when the table is right there', async () => {
      let alerted = false;
      const listener = () => {
        alerted = true;
      };
      panel.page.on('dialog', (dialog) => {
        listener();
        void dialog.dismiss();
      });

      await pressLabelled('Show on diagram');
      await panel.page.waitForTimeout(80);
      panel.page.off('dialog', listener);

      assert.equal(alerted, false, 'it warned about a table that is on screen');
      assert.deepEqual(panel.problems, []);
    });
  });

  describe('removing one pending change', () => {
    it('removes the one it is next to, not the first one', async () => {
      // These are built in a loop, and a listener that closed over the loop
      // variable rather than the index would remove the wrong change — which
      // looks like it worked, until you read the changeset.
      await panel.send({
        type: 'changeset',
        changes: [
          { index: 0, label: 'Drop column email from users', sql: 'ALTER TABLE users DROP COLUMN email' },
          { index: 1, label: 'Rename users to people', sql: 'ALTER TABLE users RENAME TO people' },
          { index: 2, label: 'Drop table orders', sql: 'DROP TABLE orders' },
        ],
        diff: { tables: [], columns: [], relationships: [], dataEdits: 0 },
        projected: SNAPSHOT,
        sql: '',
      });

      await panel.page.click('.change:has-text("Rename users to people") button:text-is("Remove")');

      const removals = ((await panel.posted()) as { type?: string; index?: number }[]).filter(
        (message) => message.type === 'removeEdit',
      );
      assert.equal(removals.length, 1);
      assert.equal(removals[0]!.index, 1, 'removed the wrong change');
    });
  });
});
