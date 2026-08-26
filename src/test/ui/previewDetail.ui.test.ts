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
 * The parts of the preview panel nothing has ever rendered.
 *
 * The offending rows, the reference scan and the trigger box all have tests
 * because they were written after the harness existed. The impact diagram, the
 * cascade tree and the query plan were written before it, and have only ever
 * been read as source — which is exactly the state the drawer was in when it
 * turned out not to open at all.
 */

const BEGIN = {
  type: 'begin',
  file: 'migrations/0008_cleanup.sql',
  connection: 'shop@neon',
  statements: [
    { index: 0, sql: 'DELETE FROM carts', startLine: 0, endLine: 0 },
    { index: 1, sql: 'ALTER TABLE users DROP COLUMN phone', startLine: 2, endLine: 2 },
    { index: 2, sql: "UPDATE orders SET status = 'archived'", startLine: 4, endLine: 4 },
  ],
};

describe('the preview panel, in detail', () => {
  let panel: Panel;

  before(async () => {
    panel = await openPanel(previewPanelHtml, { width: 1000, height: 900 });
    await panel.send(BEGIN);
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  describe('a cascade', () => {
    before(async () => {
      await panel.send({
        type: 'finding',
        finding: {
          statementIndex: 0,
          kind: 'delete',
          classification: { kind: 'delete', table: 'carts', hasWhere: false },
          severity: 'destructive',
          headline: 'Will destroy data',
          detail: 'Deletes every row in carts — all 5,000 rows.',
          rowCount: 5000,
          tableRows: 5000,
          cascade: {
            table: 'carts',
            rows: 5000,
            children: [
              {
                table: 'cart_items',
                rows: 15_000,
                children: [
                  {
                    table: 'cart_item_options',
                    rows: 2400,
                    children: [],
                    via: { constraint: 'cio_item_fkey', action: 'cascade' },
                  },
                ],
                via: { constraint: 'cart_items_cart_fkey', action: 'cascade' },
              },
              {
                table: 'cart_notes',
                rows: 800,
                children: [],
                via: { constraint: 'cart_notes_cart_fkey', action: 'set null' },
              },
            ],
          },
        },
      });
    });

    it('names every table it reaches, not only the one in the statement', async () => {
      // The whole point: ON DELETE CASCADE removes rows from tables the
      // statement never mentions.
      const text = (await panel.page.textContent('.row.destructive')) ?? '';
      assert.match(text, /cart_items/);
      assert.match(text, /cart_notes/);
    });

    it('reaches through more than one level', async () => {
      const text = (await panel.page.textContent('.row.destructive')) ?? '';
      assert.match(text, /cart_item_options/, 'a grandchild of the deleted table');
    });

    it('separates rows deleted from rows blanked', async () => {
      // ON DELETE SET NULL does not remove the row, and calling both "deleted"
      // would be a count of a thing that does not happen.
      const text = (await panel.page.textContent('.row.destructive')) ?? '';
      assert.match(text, /set null|blank|null/i);
    });

    it('is readable', async () => {
      assert.deepEqual(panel.problems, []);
      for (const selector of ['.row.destructive .detail']) {
        assert.ok((await contrast(panel.page, selector)) >= 3);
      }
    });
  });

  describe('a query plan', () => {
    before(async () => {
      await panel.send({
        type: 'finding',
        finding: {
          statementIndex: 2,
          kind: 'update',
          classification: { kind: 'update', table: 'orders' },
          severity: 'caution',
          headline: 'Changes 1,927 rows',
          detail: '1,927 of 300,000 rows in orders change.',
          rowCount: 1927,
          tableRows: 300_000,
          // The shape analysis/plan.ts really produces: a root node, a total,
          // and the insights worth saying out loud.
          plan: {
            totalMs: 812.4,
            root: {
              kind: 'Update',
              relation: 'orders',
              totalMs: 812.4,
              selfMs: 22.3,
              actualRows: 1927,
              estimatedRows: 2000,
              children: [
                {
                  kind: 'Seq Scan',
                  relation: 'orders',
                  totalMs: 790.1,
                  selfMs: 790.1,
                  actualRows: 300_000,
                  estimatedRows: 1200,
                  children: [],
                },
              ],
            },
            insights: [
              {
                kind: 'sequential-scan',
                message: 'Sequential scan over 300,000 rows in orders.',
                node: 'Seq Scan',
              },
            ],
          },
        },
      });
    });

    it('draws the plan when one was captured', async () => {
      assert.equal(await visible(panel.page, '.plan'), true);
      assert.deepEqual(panel.problems, []);
    });

    it('names the node that costs the time', async () => {
      const text = (await panel.page.textContent('.plan')) ?? '';
      assert.match(text, /Seq Scan/);
    });

    it('says the warning out loud rather than leaving it in the tree', async () => {
      const text = (await panel.page.textContent('.plan')) ?? '';
      assert.match(text, /Sequential scan over 300,000 rows/);
    });

    it('is readable', async () => {
      const bad: string[] = [];
      for (const selector of ['.plan']) {
        if ((await contrast(panel.page, selector)) < 3) {
          bad.push(selector);
        }
      }
      assert.deepEqual(bad, []);
    });
  });

  describe('the impact diagram', () => {
    before(async () => {
      await panel.send({ type: 'done', summary: '2 would destroy data. Out of 3 statements.' });
      await panel.send({
        type: 'diagram',
        diagram: {
          tables: [
            {
              name: 'carts',
              rows: 5000,
              severity: 'destructive',
              doomed: false,
              notes: [{ text: 'Every row deleted', severity: 'destructive', statementIndex: 0 }],
              columns: [
                { name: 'id', type: 'integer', isPrimaryKey: true, nullable: false },
                { name: 'user_id', type: 'integer', isPrimaryKey: false, nullable: true },
              ],
            },
            {
              name: 'users',
              rows: 50_000,
              severity: 'destructive',
              doomed: false,
              notes: [],
              columns: [
                { name: 'id', type: 'integer', isPrimaryKey: true, nullable: false },
                {
                  name: 'phone',
                  type: 'text',
                  isPrimaryKey: false,
                  nullable: true,
                  impact: 'dropped',
                  severity: 'destructive',
                  note: '40,072 rows lost',
                  statementIndex: 1,
                },
              ],
            },
          ],
          edges: [
            { fromTable: 'carts', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' },
          ],
        },
      });
    });

    it('offers a diagram tab', async () => {
      assert.equal(await visible(panel.page, '#tab-diagram'), true);
    });

    it('draws it when the tab is chosen', async () => {
      // Never rendered before this test, which is the state the schema
      // explorer's drawer was in when it turned out not to open at all.
      await panel.click('#tab-diagram');

      assert.equal(await visible(panel.page, '#diagram'), true);
      assert.equal(await visible(panel.page, '#rows'), false);
      assert.deepEqual(panel.problems, []);
      assert.ok((await count(panel.page, '#diagram .table-card')) >= 2);
    });

    it('marks the column that is about to be dropped', async () => {
      const text = (await panel.page.textContent('#diagram')) ?? '';
      assert.match(text, /phone/);
      assert.match(text, /40,072 rows lost/);
    });

    it('says what happens to the table as a whole', async () => {
      assert.match((await panel.page.textContent('#diagram')) ?? '', /Every row deleted/);
    });

    it('is readable', async () => {
      const unreadable = (await panel.page.evaluate(`
        (function () {
          var bad = [];
          var nodes = document.querySelectorAll('#diagram *');
          for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var own = '';
            for (var j = 0; j < el.childNodes.length; j++) {
              if (el.childNodes[j].nodeType === 3) { own += el.childNodes[j].textContent; }
            }
            if (own.trim().length === 0) { continue; }
            var box = el.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) { continue; }
            var style = getComputedStyle(el);
            if (Number(style.opacity) < 0.15) { bad.push(own.trim().slice(0, 20)); }
          }
          return bad;
        })()
      `)) as string[];

      assert.deepEqual(unreadable, []);
    });

    it('goes back to the list', async () => {
      await panel.click('#tab-list');
      assert.equal(await visible(panel.page, '#rows'), true);
      assert.equal(await visible(panel.page, '#diagram'), false);
    });
  });

  describe('a statement that could not be measured', () => {
    it('says unknown rather than safe', async () => {
      // The one wrong answer that matters here. A statement nobody measured is
      // not a statement that is fine.
      await panel.send({
        type: 'finding',
        finding: {
          statementIndex: 1,
          kind: 'other',
          classification: { kind: 'other' },
          severity: 'caution',
          headline: "Couldn't analyze",
          detail: 'relation "audit_log" does not exist.',
          error: 'relation "audit_log" does not exist',
        },
      });

      const badges = await texts(panel.page, '.badge');
      assert.ok(
        badges.some((badge) => /Couldn't analyze/.test(badge)),
        `badges are ${badges.join(' | ')}`,
      );
      assert.doesNotMatch((await panel.page.textContent('.row.caution')) ?? '', /\bSafe\b/);
    });
  });

  it('nothing threw at any point', () => {
    assert.deepEqual(panel.problems, []);
  });

  it('looks like this', async () => {
    await panel.shot('preview-detail');
  });
});
