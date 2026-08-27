import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { schemaPanelHtml } from '../../panel/html';
import { Panel, closeBrowser, openPanel, visible } from '../support/uiHarness';

/**
 * The visual editor's own buttons.
 *
 * These are the ones that change the database, and until now they asked their
 * questions with `window.prompt`. A webview cannot ask a question that way: VS
 * Code renders it in a sandboxed iframe without `allow-modals`, so the browser
 * ignores prompt() and returns null with nothing appearing on screen. Rename
 * table, Rename, Type and Drop table therefore did nothing at all, in every
 * window, for as long as they had existed.
 *
 * The tests did not catch it because plain Chromium shows dialogs happily. The
 * harness now blocks them the way the editor does and records every attempt, so
 * a button that reaches for one fails here instead of shipping.
 *
 * What each button does now is post an intent and let the extension ask, which
 * is where `showInputBox` lives. So what is checked here is the intent: the
 * right message, naming the right table and the right column. Whether the
 * question is any good is checked on the other side, in schemaPanel's tests.
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

interface Posted {
  type?: string;
  table?: string;
  column?: string;
  from?: string;
  rows?: number;
  tables?: string[];
  index?: number;
  edit?: { kind?: string; table?: string; column?: string };
}

describe('the visual editor, using its own buttons', () => {
  let panel: Panel;

  async function posted(): Promise<Posted[]> {
    return (await panel.posted()) as Posted[];
  }

  /** The last message of this type, if the page sent one at all. */
  async function last(type: string): Promise<Posted | undefined> {
    return (await posted()).filter((message) => message.type === type).pop();
  }

  /** Every edit the page added by itself. */
  async function edits(): Promise<NonNullable<Posted['edit']>[]> {
    return (await posted())
      .filter((message) => message.type === 'addEdit')
      .map((message) => message.edit!);
  }

  async function pressLabelled(label: string): Promise<void> {
    await panel.page.click(`#drawer button:text-is("${label}")`);
  }

  /** A button on the row for one column. */
  async function pressOnColumn(name: string, label: string): Promise<void> {
    await panel.page.click(`#drawer .drawer-col:has-text("${name}") button:text-is("${label}")`);
  }

  before(async () => {
    panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
    await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
  });

  beforeEach(async () => {
    // Both messages, in the order the extension really sends them: clicking a
    // table asks for it, `tableLoading` opens the drawer, `tableDetail` fills
    // it in.
    await panel.send({ type: 'tableLoading', table: DETAIL.table });
    await panel.send({ type: 'tableDetail', detail: DETAIL });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  it('never reaches for a dialog it cannot open', async () => {
    // The guard for the whole class, and the one test that would have caught
    // this in the first place. Pressing every button in the drawer must not
    // attempt a single alert, confirm or prompt.
    for (const label of ['Show on diagram', 'Rename table', 'Drop table']) {
      await pressLabelled(label);
    }
    for (const label of ['Rename', 'Type', 'Drop']) {
      await pressOnColumn('email', label);
    }

    assert.deepEqual(await panel.modals(), [], 'a button reached for a dialog');
    assert.deepEqual(panel.problems, []);
  });

  describe('renaming a table', () => {
    it('asks the editor to ask, naming the table', async () => {
      await pressLabelled('Rename table');

      const asked = await last('renameTable');
      assert.ok(asked, 'Rename table posted nothing at all');
      assert.equal(asked.table, 'users');
    });

    it('adds no edit by itself', async () => {
      // The page does not know the new name and must not add anything on its
      // own. The extension adds it once it has an answer.
      assert.deepEqual(
        (await edits()).filter((edit) => edit.kind === 'rename_table'),
        [],
      );
    });
  });

  describe('renaming a column', () => {
    it('names the column it sits next to, not the first one', async () => {
      await pressOnColumn('phone_number', 'Rename');

      const asked = await last('renameColumn');
      assert.ok(asked, 'Rename posted nothing at all');
      assert.equal(asked.table, 'users');
      assert.equal(asked.column, 'phone_number');
    });
  });

  describe('changing a column type', () => {
    it('carries the type it has now, so the question can offer it', async () => {
      await pressOnColumn('email', 'Type');

      const asked = await last('changeType');
      assert.ok(asked, 'Type posted nothing at all');
      assert.equal(asked.table, 'users');
      assert.equal(asked.column, 'email');
      assert.equal(asked.from, 'text');
    });
  });

  describe('dropping a table', () => {
    it('asks the editor, and carries the row count so the question can say it', async () => {
      await pressLabelled('Drop table');

      const asked = await last('dropTable');
      assert.ok(asked, 'Drop table posted nothing at all');
      assert.equal(asked.table, 'users');
      assert.equal(asked.rows, 50_000);
    });

    it('adds nothing on its own, whatever is pressed', async () => {
      // The confirmation belongs to the editor, and it is the only thing that
      // can turn this into an edit.
      assert.deepEqual(
        (await edits()).filter((edit) => edit.kind === 'drop_table'),
        [],
      );
    });
  });

  describe('dropping a column', () => {
    it('sends the drop for the column it sits next to', async () => {
      // No question to ask, so this one is still added directly.
      await pressOnColumn('phone_number', 'Drop');

      // Scoped to this column: the dialog guard above presses Drop on `email`,
      // and `posted()` accumulates for the life of the panel.
      const drops = (await edits()).filter(
        (edit) => edit.kind === 'drop_column' && edit.column === 'phone_number',
      );
      assert.equal(drops.length, 1);
      assert.deepEqual(drops[0], {
        kind: 'drop_column',
        table: 'users',
        column: 'phone_number',
      });
    });

    it('is not offered on the primary key', async () => {
      // Dropping it is legal SQL and almost never what anyone means by
      // pressing a small button next to a column.
      const onKey = await panel.page.$$(
        '#drawer .drawer-col:has-text("id") button:text-is("Drop")',
      );
      assert.equal(onKey.length, 0);
    });
  });

  describe('showing a table on the diagram', () => {
    it('tells the editor to say so when the table is not drawn', async () => {
      await panel.send({ type: 'tableLoading', table: 'not_drawn' });
      await panel.send({ type: 'tableDetail', detail: { ...DETAIL, table: 'not_drawn' } });
      await pressLabelled('Show on diagram');

      const said = await last('notDrawn');
      assert.ok(said, 'it silently did nothing, which reads as a broken button');
      assert.deepEqual(said.tables, ['not_drawn']);
    });

    it('says nothing at all when the table is right there', async () => {
      const before = (await posted()).filter((message) => message.type === 'notDrawn').length;

      await pressLabelled('Show on diagram');

      const after = (await posted()).filter((message) => message.type === 'notDrawn').length;
      assert.equal(after, before, 'it complained about a table that is on screen');
      assert.deepEqual(panel.problems, []);
    });
  });

  describe('the route between two tables', () => {
    // Per test rather than once: the outer `beforeEach` re-renders the drawer,
    // which takes the result with it.
    async function showRoute(): Promise<void> {
      await panel.send({
        type: 'joinPath',
        from: 'users',
        to: 'orders',
        found: true,
        tables: ['users', 'orders'],
        joins: 1,
        sql: 'SELECT * FROM users JOIN orders ON orders.user_id = users.id',
      });
    }

    it('lights up the cards it goes through', async () => {
      await showRoute();
      assert.equal(await panel.page.$$eval('.table.on-route', (cards) => cards.length), 2);
    });

    it('puts the route on the clipboard as SQL', async () => {
      await showRoute();
      // The real clipboard is not reachable from a page loaded this way —
      // reading it back blocks on a permission prompt that never comes — so
      // what is checked is the call, which is the part this code owns.
      // `defineProperty`, not assignment: navigator.clipboard is a read-only
      // accessor on the prototype, so `navigator.clipboard = {...}` fails
      // silently and the stub is never installed.
      await panel.page.evaluate(`
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: function (value) {
              window.__copied.push(value);
              return Promise.resolve();
            }
          }
        });
      `);

      await panel.page.click('.path-result button:text-is("Copy SQL")');

      const copied = (await panel.page.evaluate('window.__copied')) as string[];
      assert.equal(copied.length, 1, 'Copy SQL copied nothing');
      assert.match(copied[0]!, /JOIN orders ON orders\.user_id = users\.id/);
      assert.deepEqual(panel.problems, []);
    });

    it('takes the route back off the diagram when asked', async () => {
      await showRoute();
      assert.equal(await panel.page.$$eval('.table.on-route', (cards) => cards.length), 2);

      await panel.page.click('.path-result button:text-is("Clear route")');
      await panel.page.waitForTimeout(60);

      assert.equal(await panel.page.$$eval('.table.on-route', (cards) => cards.length), 0);
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
          {
            index: 0,
            label: 'Drop column email from users',
            sql: 'ALTER TABLE users DROP COLUMN email',
          },
          { index: 1, label: 'Rename users to people', sql: 'ALTER TABLE users RENAME TO people' },
          { index: 2, label: 'Drop table orders', sql: 'DROP TABLE orders' },
        ],
        diff: { tables: [], columns: [], relationships: [], dataEdits: 0 },
        projected: SNAPSHOT,
        sql: '',
      });

      await panel.page.click('.change:has-text("Rename users to people") button:text-is("Remove")');

      const removals = (await posted()).filter((message) => message.type === 'removeEdit');
      assert.equal(removals.length, 1);
      assert.equal(removals[0]!.index, 1, 'removed the wrong change');
    });
  });

  it('reached for no dialog at any point', async () => {
    assert.deepEqual(await panel.modals(), []);
  });
});

/**
 * The editor, told it is talking to MongoDB.
 *
 * The panel used to say "Export SQL" on a MongoDB connection and offer a
 * Require button for a database that has no nullability to declare. Both were
 * the visible half of a larger lie — the file behind that button really was
 * SQL — and both are decided by what the extension sends with the changeset
 * rather than by anything baked into the markup.
 */
describe('the editor, per engine', () => {
  let panel: Panel;

  const CHANGES = [
    { index: 0, label: 'Drop users.legacy_utm', sql: 'db.getCollection("users").updateMany(...)' },
  ];

  const EMPTY_DIFF = { tables: [], columns: [], relationships: [], dataEdits: 0 };

  const changeset = (dialect?: Record<string, unknown>) => ({
    type: 'changeset',
    changes: CHANGES,
    diff: EMPTY_DIFF,
    projected: SNAPSHOT,
    sql: '',
    ...(dialect ? { dialect } : {}),
  });

  before(async () => {
    panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
    await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'analytics@local' });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  it('says SQL until it is told otherwise', async () => {
    // Two of the three engines take SQL, and a panel that has not heard from
    // the extension yet has nothing better to guess.
    await panel.send(changeset());

    assert.equal(await panel.page.textContent('#export'), 'Export SQL');
    assert.equal(await panel.page.textContent('#export-down'), 'Down SQL');
  });

  it('renames its own buttons when the engine does not speak SQL', async () => {
    await panel.send(
      changeset({
        noun: 'operation',
        exportLabel: 'Export script',
        downLabel: 'Down script',
        hasNullability: false,
        hasDownMigration: true,
      }),
    );

    assert.equal(await panel.page.textContent('#export'), 'Export script');
    assert.equal(await panel.page.textContent('#export-down'), 'Down script');
    assert.deepEqual(panel.problems, []);
  });

  it('stops offering nullability where there is none to declare', async () => {
    // A field in MongoDB is absent, null, or has a value, and nothing enforces
    // which. The button is not offered rather than offered and refused.
    await panel.send({ type: 'tableLoading', table: DETAIL.table });
    await panel.send({ type: 'tableDetail', detail: DETAIL });

    const labels = await panel.page.$$eval('#drawer .drawer-col button', (buttons) =>
      buttons.map((button) => button.textContent),
    );

    assert.ok(labels.includes('Rename'), `the other buttons are still there: ${labels.join(', ')}`);
    assert.ok(labels.includes('Drop'));
    assert.ok(!labels.includes('Require'), 'Require is offered on a database with no NOT NULL');
    assert.ok(!labels.includes('Allow null'));
  });

  it('offers them again when the engine has them', async () => {
    await panel.send(
      changeset({
        noun: 'statement',
        exportLabel: 'Export SQL',
        downLabel: 'Down SQL',
        hasNullability: true,
        hasDownMigration: true,
      }),
    );
    await panel.send({ type: 'tableLoading', table: DETAIL.table });
    await panel.send({ type: 'tableDetail', detail: DETAIL });

    const labels = await panel.page.$$eval('#drawer .drawer-col button', (buttons) =>
      buttons.map((button) => button.textContent),
    );

    assert.ok(
      labels.includes('Require') || labels.includes('Allow null'),
      `nullability is gone on an engine that has it: ${labels.join(', ')}`,
    );
    assert.deepEqual(panel.problems, []);
  });

  it('hides the Down button for an engine that cannot generate one', async () => {
    // Every engine can today. The flag stays because the next one might not,
    // and because a button offered and refused is worse than one not offered.
    await panel.send(
      changeset({
        noun: 'operation',
        exportLabel: 'Export script',
        downLabel: 'Down script',
        hasNullability: false,
        hasDownMigration: false,
      }),
    );

    assert.equal(await visible(panel.page, '#export-down'), false);
    assert.equal(await visible(panel.page, '#export'), true, 'the others stay');
  });
});

/**
 * Finding one row among a quarter of a million.
 *
 * The drawer shows the first twenty-five rows, and a search box that asks the
 * extension for the ones matching a value instead. `filter` and `matched` are
 * what come back, and neither had ever been sent to the panel — so the filtered
 * heading, the count beside it, and the answer when nothing matches had all
 * only been read as source.
 *
 * Without it the drawer edits the first twenty-five rows of a table rather than
 * the table, which is a different feature wearing the same buttons.
 */
describe('finding a row in the drawer', () => {
  let panel: Panel;

  const COLUMNS = [
    { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
    { name: 'email', type: 'text', nullable: true, isPrimaryKey: false },
  ];

  const SNAPSHOT = {
    schemas: ['public'],
    tables: [
      {
        schema: 'public',
        name: 'users',
        qualified: 'users',
        rows: 250_000,
        bytes: 40_000_000,
        partitioned: false,
        columns: COLUMNS,
      },
    ],
    foreignKeys: [],
  };

  const detail = (extra: Record<string, unknown>) => ({
    type: 'tableDetail',
    detail: {
      table: 'users',
      rows: 250_000,
      rowsEstimated: false,
      primaryKey: ['id'],
      columns: COLUMNS,
      indexes: [],
      constraints: [],
      sample: [],
      sampleRaw: [],
      ...extra,
    },
  });

  before(async () => {
    panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
    await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  it('says these are the first rows when nothing was asked for', async () => {
    await panel.send({ type: 'tableLoading', table: 'users' });
    await panel.send(
      detail({
        sample: [{ id: '1', email: 'a@example.com' }],
        sampleRaw: [{ id: 1, email: 'a@example.com' }],
      }),
    );

    const text = (await panel.page.textContent('#drawer')) ?? '';
    assert.match(text, /Rows \(first 1\)/);
    assert.deepEqual(panel.problems, []);
  });

  it('says what it matched, and how many, once a filter is in play', async () => {
    await panel.send({ type: 'tableLoading', table: 'users' });
    await panel.send(
      detail({
        filter: 'acme',
        matched: 3,
        sample: [
          { id: '11', email: 'one@acme.test' },
          { id: '12', email: 'two@acme.test' },
        ],
        sampleRaw: [
          { id: 11, email: 'one@acme.test' },
          { id: 12, email: 'two@acme.test' },
        ],
      }),
    );

    const text = (await panel.page.textContent('#drawer')) ?? '';
    assert.match(text, /Rows matching "acme" \(2\)/);
    assert.doesNotMatch(text, /Rows \(first/, 'it is still calling them the first rows');
  });

  it('keeps what was typed in the box, so the search can be refined', async () => {
    // Clearing it would mean retyping the whole thing to change one character.
    assert.equal(await panel.page.inputValue('#drawer input[type="search"]'), 'acme');
  });

  it('says nothing matched, rather than showing an empty table', async () => {
    await panel.send({ type: 'tableLoading', table: 'users' });
    await panel.send(detail({ filter: 'nobody', matched: 0, sample: [], sampleRaw: [] }));

    const text = (await panel.page.textContent('#drawer')) ?? '';
    assert.match(text, /Nothing matched that/);
    assert.doesNotMatch(text, /This table is empty/, 'the table is not empty, the filter missed');
  });

  it('says the table is empty when it really is', async () => {
    await panel.send({ type: 'tableLoading', table: 'users' });
    await panel.send(detail({ sample: [], sampleRaw: [] }));

    assert.match((await panel.page.textContent('#drawer')) ?? '', /This table is empty/);
  });

  it('asks the extension when Find is pressed', async () => {
    await panel.send({ type: 'tableLoading', table: 'users' });
    await panel.send(detail({ sample: [], sampleRaw: [] }));

    await panel.page.fill('#drawer input[type="search"]', 'acme');
    await panel.page.click('#drawer button:text-is("Find")');

    const asked = ((await panel.posted()) as { type?: string; table?: string; filter?: string }[])
      .filter((message) => message.type === 'openTable')
      .pop();

    assert.ok(asked, 'Find posted nothing at all');
    assert.equal(asked.table, 'users');
    assert.equal(asked.filter, 'acme');
  });

  it('asks on enter too, because that is what a search box is for', async () => {
    await panel.page.fill('#drawer input[type="search"]', 'globex');
    await panel.page.press('#drawer input[type="search"]', 'Enter');

    const asked = ((await panel.posted()) as { type?: string; filter?: string }[])
      .filter((message) => message.type === 'openTable')
      .pop();

    assert.equal(asked?.filter, 'globex');
    assert.deepEqual(panel.problems, []);
  });

  it('shows a field the inference missed, rather than hiding half the row', async () => {
    // The column list for MongoDB is inferred from a sample and the rows shown
    // are a different query, so a document can hold a field the inference never
    // saw. Showing a row while quietly dropping part of it is the one thing a
    // table of real data must not do.
    await panel.send({ type: 'tableLoading', table: 'users' });
    await panel.send(
      detail({
        sample: [{ id: '1', email: 'a@example.com', 'profile.locale': 'fr-FR' }],
        sampleRaw: [{ id: 1, email: 'a@example.com', 'profile.locale': 'fr-FR' }],
      }),
    );

    const text = (await panel.page.textContent('#drawer')) ?? '';
    assert.match(text, /profile\.locale/, 'a field only the row carries was dropped');
    assert.match(text, /fr-FR/);
  });
});
