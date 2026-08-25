import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { schemaPanelHtml } from '../../panel/html';
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
 * The schema explorer, rendered.
 *
 * Both of the bugs that made this file necessary lived here. Clicking a table
 * did nothing, because the card stopped its own click from propagating and the
 * delegated listener above it never fired. And the Drop button was red on red,
 * because one rule set the background and another won the fight for the colour
 * — so the word "Drop" appeared only on hover.
 *
 * Neither was findable by reading the source, and both are one assertion here.
 */

const column = (name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  isPrimaryKey: false,
  ...extra,
});

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
      columns: [
        column('id', 'integer', { isPrimaryKey: true, nullable: false }),
        column('email'),
        column('tier', 'text', { nullable: false }),
        column('phone_number'),
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
        column('status', 'text', { nullable: false }),
        column('total_cents', 'integer'),
      ],
    },
    {
      schema: 'public',
      name: 'order_items',
      qualified: 'order_items',
      rows: 600_000,
      bytes: 180_000_000,
      partitioned: false,
      columns: [
        column('id', 'integer', { isPrimaryKey: true, nullable: false }),
        column('order_id', 'integer', { nullable: false }),
        column('product_id', 'integer', { nullable: false }),
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
    {
      name: 'order_items_order_id_fkey',
      fromTable: 'order_items',
      fromColumns: ['order_id'],
      toTable: 'orders',
      toColumns: ['id'],
    },
  ],
};

describe('the schema explorer, rendered', () => {
  let panel: Panel;

  before(async () => {
    panel = await openPanel(schemaPanelHtml, { width: 1200, height: 820 });
    await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  it('loads both scripts without either throwing', () => {
    // The bug this catches killed the entire visual editor while the diagram
    // beside it worked perfectly: two scripts in one webview, both calling
    // acquireVsCodeApi, the second throwing on its first line.
    assert.deepEqual(panel.problems, []);
  });

  it('draws a card per table', async () => {
    assert.equal(await count(panel.page, '.table'), 3);
    const names = await texts(panel.page, '.table-title');
    assert.deepEqual([...names].sort(), ['order_items', 'orders', 'users']);
  });

  it('draws the columns inside them', async () => {
    const columns = await texts(panel.page, '.table[data-table="users"] .col-name');
    assert.deepEqual(columns, ['id', 'email', 'tier', 'phone_number']);
  });

  it('lays the cards out somewhere other than on top of each other', async () => {
    // A layout that puts every card at 0,0 renders, passes every static check,
    // and is unusable.
    const boxes = (await panel.page.evaluate(`
      Array.prototype.map.call(document.querySelectorAll('.table'), function (card) {
        var box = card.getBoundingClientRect();
        return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width) };
      })
    `)) as { x: number; y: number; w: number }[];

    assert.equal(boxes.length, 3);
    assert.ok(
      boxes.every((box) => box.w > 100),
      'each card has real width',
    );
    const positions = new Set(boxes.map((box) => `${box.x},${box.y}`));
    assert.equal(positions.size, 3, 'no two cards share a position');
  });

  it('draws an edge per relationship', async () => {
    const edges = await count(panel.page, '#edges path, #edges line');
    assert.ok(edges >= SNAPSHOT.foreignKeys.length, `only ${edges} edges drawn`);
  });

  it('says how much it drew', async () => {
    assert.match((await panel.page.textContent('#stats')) ?? '', /3 tables, 2 relationships/);
  });

  describe('clicking a table', () => {
    it('reaches the extension', async () => {
      // The exact bug: the card calls stopPropagation so that the stage's
      // handler does not immediately clear the selection, which meant nothing
      // above the card ever saw the click. It announces through the bridge now,
      // and this is the assertion that says so.
      await panel.click('.table[data-table="users"] .table-head');

      const posted = (await panel.posted()) as { type?: string; table?: string }[];
      assert.ok(
        posted.some((message) => message.type === 'openTable' && message.table === 'users'),
        `clicking the card asked for nothing. Posted: ${JSON.stringify(posted)}`,
      );
    });

    it('opens the drawer when the detail arrives', async () => {
      await panel.send({
        type: 'tableDetail',
        detail: {
          table: 'users',
          rows: 50_000,
          rowsEstimated: false,
          primaryKey: ['id'],
          columns: SNAPSHOT.tables[0]!.columns,
          indexes: [
            {
              name: 'users_pkey',
              columns: ['id'],
              unique: true,
              primary: true,
              definition: 'CREATE UNIQUE INDEX users_pkey ON users (id)',
            },
          ],
          constraints: [
            { name: 'users_pkey', type: 'primary key', definition: 'PRIMARY KEY (id)' },
          ],
          sample: [
            { id: '1', email: 'a@example.com', tier: 'pro', phone_number: '+15550001' },
            { id: '2', email: 'b@example.com', tier: 'free', phone_number: '∅' },
          ],
          // The panel sends the raw values alongside the display ones, because
          // editing a cell needs the real key rather than its rendering.
          sampleRaw: [
            { id: 1, email: 'a@example.com', tier: 'pro', phone_number: '+15550001' },
            { id: 2, email: 'b@example.com', tier: 'free', phone_number: null },
          ],
        },
      });

      assert.equal(await visible(panel.page, '#drawer'), true, 'the drawer is on screen');
      assert.match((await panel.page.textContent('#drawer')) ?? '', /users/);
    });

    it('shows real rows in it', async () => {
      const text = (await panel.page.textContent('#drawer')) ?? '';
      assert.match(text, /a@example\.com/, 'the sample rows are the point of opening it');
    });
  });

  describe('the buttons in the drawer', () => {
    it('are all readable against their own background', async () => {
      // The red-on-red Drop button. Every one of these is checked rather than
      // just that one, because the bug was a specificity accident and the next
      // one will be too.
      const buttons = (await panel.page.evaluate(`
        Array.prototype.map.call(
          document.querySelectorAll('#drawer button'),
          function (button, index) {
            button.setAttribute('data-ui-test', String(index));
            return { index: index, label: (button.textContent || '').trim() };
          }
        )
      `)) as { index: number; label: string }[];

      assert.ok(buttons.length > 0, 'the drawer has controls at all');

      const unreadable: string[] = [];
      for (const button of buttons) {
        const ratio = await contrast(panel.page, `#drawer [data-ui-test="${button.index}"]`);
        if (ratio < 3) {
          unreadable.push(`${button.label || '(no label)'} at ${ratio.toFixed(2)}`);
        }
      }

      assert.deepEqual(unreadable, [], `unreadable controls: ${unreadable.join(', ')}`);
    });

    it('all have a label that is actually there', async () => {
      const labels = await texts(panel.page, '#drawer button');
      const blank = labels.filter((label) => label.length === 0);
      assert.deepEqual(blank, [], 'a button with no text is a button nobody can use');
    });
  });

  describe('the overlays', () => {
    it('offers them', async () => {
      assert.equal(await visible(panel.page, '#overlay'), true);
      const options = await texts(panel.page, '#overlay option');
      assert.ok(options.includes('Colour by rows'));
      assert.ok(options.includes('Foreign keys with no index'));
    });

    it('colours the cards when one is chosen', async () => {
      await panel.page.selectOption('#overlay', 'rows');
      await panel.page.waitForTimeout(50);

      assert.equal(
        await count(panel.page, '.table.overlaid'),
        3,
        'every table has rows, so every card should be shaded',
      );
      assert.equal(await visible(panel.page, '#overlay-note'), true);
      assert.match(
        (await panel.page.textContent('#overlay-note')) ?? '',
        /order_items leads with 600/,
        'the biggest table is named',
      );
    });

    it('shades them differently rather than all the same', async () => {
      // The whole point is telling them apart. A scale that paints every card
      // the same colour has drawn nothing.
      const heats = (await panel.page.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('.table.overlaid'), function (card) {
          return card.style.getPropertyValue('--heat');
        })
      `)) as string[];

      assert.equal(new Set(heats).size, 3, `all cards got the same shade: ${heats.join(', ')}`);
    });

    it('swaps the card subtitle for the measurement being shown', async () => {
      const metas = await texts(panel.page, '.table.overlaid .table-meta');
      assert.ok(
        metas.every((meta) => /rows$/.test(meta)),
        `subtitles still show the default: ${metas.join(' | ')}`,
      );
    });

    it('asks the extension for statistics when the overlay needs them', async () => {
      await panel.page.selectOption('#overlay', 'fk');
      await panel.page.waitForTimeout(50);

      const posted = (await panel.posted()) as { type?: string }[];
      assert.ok(posted.some((message) => message.type === 'health'));
    });

    it('colours by the answer once it arrives', async () => {
      await panel.send({
        type: 'health',
        health: {
          statsSince: '2026-08-01T00:00:00.000Z',
          unusedIndexes: [],
          redundantIndexes: [],
          unindexedForeignKeys: [
            {
              constraint: 'orders_user_id_fkey',
              table: 'orders',
              columns: ['user_id'],
              referencedTable: 'users',
              rows: 300_000,
            },
          ],
          tables: [],
        },
      });

      assert.equal(
        await count(panel.page, '.table.overlaid'),
        1,
        'only the table with an unindexed key is shaded',
      );
      assert.equal(
        await panel.page.textContent('.table.overlaid .table-title'),
        'orders',
      );
    });

    it('goes back to normal when turned off', async () => {
      await panel.page.selectOption('#overlay', 'none');
      await panel.page.waitForTimeout(50);

      assert.equal(await count(panel.page, '.table.overlaid'), 0);
      assert.equal(await visible(panel.page, '#overlay-note'), false);
      assert.match(
        (await panel.page.textContent('.table[data-table="users"] .table-meta')) ?? '',
        /·/,
        'the rows-and-size subtitle is back',
      );
    });
  });

  describe('the toolbar', () => {
    it('keeps every control on one line', async () => {
      // It used to solve a narrow window by wrapping "Re-layout" across two
      // lines and growing taller, which reads as broken rather than as tight.
      const heights = (await panel.page.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('#toolbar button'), function (button) {
          return Math.round(button.getBoundingClientRect().height);
        })
      `)) as number[];

      const tallest = Math.max(...heights);
      const shortest = Math.min(...heights);
      assert.ok(
        tallest - shortest < 6,
        `buttons range from ${shortest}px to ${tallest}px, so one has wrapped`,
      );
    });
  });

  describe('opening a table you can barely see', () => {
    it('brings it out from behind the drawer', async () => {
      // You click a table and the drawer opens over the top of it, so the
      // thing you clicked is the thing that disappears. Panning is minimal
      // and only happens when the card is actually clipped.
      const clipped = (await panel.page.evaluate(`
        (function () {
          var card = document.querySelector('.table[data-table="users"]');
          var stage = document.getElementById('stage');
          var a = card.getBoundingClientRect();
          var b = stage.getBoundingClientRect();
          return a.right > b.right || a.left < b.left || a.bottom > b.bottom || a.top < b.top;
        })()
      `)) as boolean;

      assert.equal(clipped, false, 'the opened table is fully on screen');
    });
  });

  it('nothing threw at any point', () => {
    assert.deepEqual(panel.problems, []);
  });

  it('looks like this', async () => {
    await panel.shot('schema-explorer');
  });

  describe('when a message is not the shape it expects', () => {
    it('says so instead of dying quietly', async () => {
      // Found by this very file: the drawer read `detail.sampleRaw[index]` and
      // a message without that field threw, which removed nothing and broke
      // everything — the listener survived and ignored every message after it,
      // with nothing on screen to say why. Indistinguishable from a feature
      // nobody wrote, which is how the last two bugs here presented.
      await panel.send({ type: 'tableDetail', detail: { table: 'users' } });

      assert.equal(await visible(panel.page, '#drawer'), true);
      assert.match(
        (await panel.page.textContent('#drawer')) ?? '',
        /went wrong|Could not/i,
        'the failure is on screen',
      );
    });

    it('keeps listening afterwards', async () => {
      // The half that matters more. A panel that reports one failure and then
      // ignores everything is no better than one that says nothing.
      await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
      assert.equal(await count(panel.page, '.table'), 3, 'still drawing');
    });
  });
});
