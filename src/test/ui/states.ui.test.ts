import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { previewPanelHtml, schemaPanelHtml, sidebarHtml } from '../../panel/html';
import { Panel, closeBrowser, openPanel, visible } from '../support/uiHarness';

/**
 * The states nothing had ever drawn.
 *
 * Every panel handles a dozen messages and the tests so far send four of them.
 * The rest — the waiting states, the failure states, the ones that only appear
 * after something has gone wrong — were written, shipped, and never rendered
 * anywhere. That is exactly the state the drawer was in when it turned out not
 * to open at all, and the failure states are the worst place for it: they are
 * the ones a user only reaches on a bad day, and the ones nobody clicks through
 * by hand, because reaching them means breaking something first.
 *
 * Listed by asking which message types the webviews handle and which ones no
 * test had ever sent. Twelve, at the time this was written.
 */

const column = (name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  isPrimaryKey: false,
  ...extra,
});

const table = (name: string, rows: number, columns: ReturnType<typeof column>[]) => ({
  schema: 'public',
  name,
  qualified: name,
  rows,
  bytes: rows * 200,
  partitioned: false,
  columns,
});

const SNAPSHOT = {
  schemas: ['public'],
  tables: [
    table('users', 50_000, [
      column('id', 'integer', { isPrimaryKey: true, nullable: false }),
      column('email'),
    ]),
    table('orders', 300_000, [
      column('id', 'integer', { isPrimaryKey: true, nullable: false }),
      column('user_id', 'integer', { nullable: false }),
    ]),
    table('order_items', 600_000, [
      column('id', 'integer', { isPrimaryKey: true, nullable: false }),
      column('order_id', 'integer', { nullable: false }),
    ]),
  ],
  foreignKeys: [
    {
      name: 'orders_user_id_fkey',
      fromTable: 'orders',
      fromColumns: ['user_id'],
      toTable: 'users',
      toColumns: ['id'],
    },
    {
      name: 'order_items_order_id_fkey',
      fromTable: 'order_items',
      fromColumns: ['order_id'],
      toTable: 'orders',
      toColumns: ['id'],
    },
  ],
};

const EMPTY_DIFF = { tables: [], columns: [], relationships: [], dataEdits: 0 };

/** The words on screen, wherever on it they are. */
const said = async (panel: Panel) => (await panel.page.textContent('body')) ?? '';

describe('the states nothing had ever drawn', () => {
  after(async () => {
    await closeBrowser();
  });

  describe('the sidebar, mid-connection', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(sidebarHtml, { width: 300, height: 820 });
      await panel.send({ type: 'state', connected: null, saved: [] });
    });

    after(async () => {
      await panel.close();
    });

    it('swaps the form for something that says it is working', async () => {
      // Connecting to a cold Neon branch takes seconds. A form that sits there
      // unchanged reads as a button that did nothing, and the second press
      // opens a second connection.
      await panel.send({ type: 'connecting' });

      assert.equal(await visible(panel.page, '#busy'), true);
      assert.equal(await visible(panel.page, '#connect'), false);
      assert.deepEqual(panel.problems, []);
    });

    it('clears the box once connected, rather than leaving the string on screen', async () => {
      // It has a password in it. Leaving it in an input in the sidebar leaves
      // it in every screen share and every screenshot from then on.
      await panel.send({ type: 'state', connected: null, saved: [] });
      await panel.page.fill('#connection', 'postgresql://user:hunter2@db.example.com/shop');
      await panel.send({ type: 'connected' });

      assert.equal(await panel.page.inputValue('#connection'), '');
      assert.doesNotMatch(await said(panel), /hunter2/);
    });

    it('takes down an earlier failure when a later attempt works', async () => {
      await panel.send({ type: 'failed', message: 'password authentication failed' });
      assert.equal(await visible(panel.page, '#error'), true);

      await panel.send({ type: 'connected' });
      assert.equal(await visible(panel.page, '#error'), false);
    });

    it('comes back to the form when an attempt fails, rather than staying busy', async () => {
      // Staying on the spinner is the one unrecoverable state: nothing to
      // press, and nothing that says why.
      await panel.send({ type: 'connecting' });
      await panel.send({ type: 'failed', message: 'could not connect to the server' });

      assert.equal(await visible(panel.page, '#busy'), false);
      assert.equal(await visible(panel.page, '#connect'), true);
      assert.match(await said(panel), /could not connect to the server/);
    });
  });

  describe('the schema explorer, before and after it fails', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
    });

    after(async () => {
      await panel.close();
    });

    it('says it is reading, before there is anything to draw', async () => {
      await panel.send({ type: 'loading', connection: 'shop@neon' });

      assert.equal(await visible(panel.page, '#status'), true);
      assert.match(await said(panel), /Reading the schema/);
      assert.match((await panel.page.textContent('#connection')) ?? '', /shop@neon/);
    });

    it('says why, when the schema cannot be read at all', async () => {
      await panel.send({ type: 'failed', message: 'permission denied for schema public' });

      assert.match(await said(panel), /permission denied for schema public/);
      assert.match((await panel.page.textContent('#stats')) ?? '', /Could not read the schema/);
      assert.deepEqual(panel.problems, []);
    });

    it('draws the schema over the top of the failure', async () => {
      await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });

      assert.equal(await visible(panel.page, '#status'), false);
      assert.deepEqual(panel.problems, []);
    });

    it('says the statistics are missing without losing the diagram', async () => {
      // Row counts come from a second query a read-only role often cannot run.
      // Losing the picture over it would be the wrong trade.
      await panel.send({
        type: 'healthFailed',
        message: 'permission denied for pg_stat_user_tables',
      });

      assert.equal(await visible(panel.page, '#overlay-note'), true);
      assert.match(
        (await panel.page.textContent('#overlay-note')) ?? '',
        /permission denied for pg_stat_user_tables/,
      );
      assert.equal((await panel.page.$$('.table')).length, 3, 'the diagram is still there');
    });
  });

  describe('the drawer, waiting and failing', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
      await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
    });

    after(async () => {
      await panel.close();
    });

    it('opens with something in it while the table is being read', async () => {
      // Opening empty and filling in later looks like a drawer that broke.
      await panel.send({ type: 'tableLoading', table: 'users' });

      assert.equal(await visible(panel.page, '#drawer'), true);
      assert.match((await panel.page.textContent('#drawer')) ?? '', /users/);
      assert.deepEqual(panel.problems, []);
    });

    it('says why, when that one table cannot be read', async () => {
      await panel.send({
        type: 'tableError',
        table: 'users',
        message: 'permission denied for table users',
      });

      const text = (await panel.page.textContent('#drawer')) ?? '';
      assert.match(text, /permission denied for table users/);
      assert.match(text, /users/);
      assert.deepEqual(panel.problems, []);
    });

    it('draws a route between two tables, and says so when there is none', async () => {
      await panel.send({
        type: 'tableDetail',
        detail: {
          table: 'users',
          rows: 50_000,
          rowsEstimated: false,
          primaryKey: ['id'],
          columns: SNAPSHOT.tables[0]!.columns,
          indexes: [],
          constraints: [],
          sample: [],
          sampleRaw: [],
        },
      });

      await panel.send({
        type: 'joinPath',
        from: 'users',
        to: 'order_items',
        found: true,
        tables: ['users', 'orders', 'order_items'],
        joins: 2,
        sql: 'SELECT *\n  FROM users\n  JOIN orders ON orders.user_id = users.id',
      });

      const found = (await panel.page.textContent('.path-result')) ?? '';
      assert.match(found, /2 joins/);
      assert.match(found, /users . orders . order_items/);
      assert.match(found, /JOIN orders ON orders\.user_id = users\.id/);

      await panel.send({
        type: 'joinPath',
        from: 'users',
        to: 'nowhere',
        found: false,
        tables: [],
        joins: 0,
        sql: '',
      });

      assert.match((await panel.page.textContent('.path-result')) ?? '', /No route/);
      assert.deepEqual(panel.problems, []);
    });
  });

  describe('a changeset being measured and applied', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
      await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
      await panel.send({
        type: 'changeset',
        changes: [
          {
            index: 0,
            label: 'Drop column email from users',
            sql: 'ALTER TABLE users DROP COLUMN email',
          },
        ],
        diff: EMPTY_DIFF,
        projected: SNAPSHOT,
        sql: '',
      });
    });

    after(async () => {
      await panel.close();
    });

    it('says it is measuring, rather than leaving the last answer up', async () => {
      // Leaving the previous summary on screen while a new measurement runs
      // shows numbers describing changes that are no longer there.
      await panel.send({ type: 'previewStarted' });

      assert.match(
        (await panel.page.textContent('#changes-body')) ?? '',
        /Measuring against your data/,
      );
    });

    it('says how many were applied, and stops offering to apply them again', async () => {
      await panel.send({
        type: 'preview',
        summary: 'ok',
        destructive: false,
        blocking: false,
        canApply: true,
        findings: [],
        affected: {},
      });
      assert.equal(await visible(panel.page, '#apply'), true);

      await panel.send({ type: 'applied', applied: 1 });

      assert.match((await panel.page.textContent('#changes-body')) ?? '', /Applied 1 change/);
      assert.equal(
        await visible(panel.page, '#apply'),
        false,
        'applying the same changes twice is the worst mistake available here',
      );
      assert.deepEqual(panel.problems, []);
    });

    it('says plainly that nothing happened when the confirmation is declined', async () => {
      // "Cancelled" on its own leaves open the question of how far it got.
      await panel.send({ type: 'applyCancelled' });

      assert.match(
        (await panel.page.textContent('#changes-body')) ?? '',
        /Not applied\. Nothing was changed\./,
      );
    });

    it('puts a failure where the summary was, not in a dialog that closes', async () => {
      await panel.send({
        type: 'error',
        message: 'deadlock detected; the changes were rolled back',
      });

      assert.match(
        (await panel.page.textContent('#changes-body')) ?? '',
        /deadlock detected; the changes were rolled back/,
      );
      assert.deepEqual(panel.problems, []);
    });
  });

  describe('the preview panel following the cursor', () => {
    let panel: Panel;

    before(async () => {
      panel = await openPanel(previewPanelHtml, { width: 900, height: 800 });
      await panel.send({
        type: 'begin',
        file: 'migrations/0009.sql',
        connection: 'shop@neon',
        statements: [
          { index: 0, sql: 'DELETE FROM carts', startLine: 0, endLine: 0 },
          { index: 1, sql: 'ALTER TABLE users DROP COLUMN phone', startLine: 2, endLine: 2 },
        ],
      });
    });

    after(async () => {
      await panel.close();
    });

    it('marks the statement the cursor is in', async () => {
      await panel.send({ type: 'highlight', index: 1 });

      const marked = await panel.page.$$('.row.current');
      assert.equal(marked.length, 1, 'exactly one row is the current one');
      assert.match((await marked[0]!.textContent()) ?? '', /DROP COLUMN phone/);
    });

    it('moves the mark rather than adding a second one', async () => {
      await panel.send({ type: 'highlight', index: 0 });

      const marked = await panel.page.$$('.row.current');
      assert.equal(marked.length, 1);
      assert.match((await marked[0]!.textContent()) ?? '', /DELETE FROM carts/);
    });

    it('takes the mark away when the cursor leaves the file', async () => {
      await panel.send({ type: 'highlight', index: null });

      assert.equal((await panel.page.$$('.row.current')).length, 0);
      assert.deepEqual(panel.problems, []);
    });
  });
});
