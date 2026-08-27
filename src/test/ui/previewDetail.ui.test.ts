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

/**
 * The four parts of a finding nothing had ever drawn.
 *
 * `lock`, `queuedBehind`, `rewrites` and `estimated` are all rendered by
 * panel.js and none had appeared in a test — including the two the README leads
 * with: the warning that your migration will wait behind a fourteen-minute
 * report, and the offer of a safer way to write the statement.
 *
 * They are among the most useful things this panel says, and they had only ever
 * been read as source.
 */
describe('the parts of a finding nothing had drawn', () => {
  let panel: Panel;

  const begin = {
    type: 'begin',
    file: 'migrations/0013.sql',
    connection: 'shop@neon',
    statements: [{ index: 0, sql: 'CREATE INDEX ON orders (user_id)', startLine: 0, endLine: 0 }],
  };

  const finding = (extra: Record<string, unknown>) => ({
    type: 'finding',
    finding: {
      statementIndex: 0,
      kind: 'create_index',
      classification: { kind: 'create_index', table: 'orders', concurrently: false },
      severity: 'blocking',
      headline: 'Locks the table',
      detail: 'Building this index holds a lock for about 12 seconds.',
      ...extra,
    },
  });

  before(async () => {
    panel = await openPanel(previewPanelHtml, { width: 1000, height: 900 });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  describe('the lock it takes', () => {
    it('says which lock, and whether it is held throughout', async () => {
      await panel.send(begin);
      await panel.send(finding({ lock: { level: 'SHARE', blocks: 'writes', brief: false } }));

      const note = (await panel.page.textContent('.lock-note')) ?? '';
      assert.match(note, /SHARE/);
      assert.match(note, /blocks writes/);
      assert.match(note, /held for the whole operation/);
      assert.deepEqual(panel.problems, []);
    });

    it('says so when the lock is only an instant', async () => {
      // The difference between "this blocks writes" and "this blocks writes for
      // a moment" is the difference between a maintenance window and a Tuesday.
      await panel.send(begin);
      await panel.send(
        finding({ lock: { level: 'ACCESS EXCLUSIVE', blocks: 'everything', brief: true } }),
      );

      assert.match((await panel.page.textContent('.lock-note')) ?? '', /held only for an instant/);
    });

    it('says nothing at all when no lock is taken', async () => {
      await panel.send(begin);
      await panel.send(finding({ lock: { level: 'NONE', blocks: 'nothing', brief: true } }));

      assert.equal(await count(panel.page, '.lock-note'), 0);
    });
  });

  describe('the queue in front of it', () => {
    const blockers = [
      {
        pid: 4821,
        state: 'active',
        seconds: 842,
        applicationName: 'metabase',
        query: 'SELECT * FROM orders WHERE created_at > now()',
      },
      { pid: 5190, state: 'idle in transaction', seconds: 31, applicationName: 'psql', query: '' },
    ];

    it('leads with the fact that everything behind it waits too', async () => {
      // The cost is not the waiting. It is that every query arriving after
      // yours queues behind you, including reads.
      await panel.send(begin);
      await panel.send(finding({ queuedBehind: blockers }));

      const warning = (await panel.page.textContent('.queue-warning')) ?? '';
      assert.match(warning, /This will queue/);
      assert.match(warning, /2 sessions are holding a conflicting lock on orders/);
      assert.match(warning, /every query that arrives after yours waits behind you/);
    });

    it('names each session, with how long it has been running', async () => {
      // Two sessions and one line of advice underneath them.
      const lines = await texts(panel.page, '.queue-blocker');
      assert.equal(lines.length, 3);
      assert.match(lines[0]!, /pid 4821/);
      assert.match(lines[0]!, /active/);
      assert.match(lines[0]!, /metabase/);
      assert.match(lines[1]!, /pid 5190/);
    });

    it('says how to end the oldest one, in this engine', async () => {
      // Advice someone may well paste into a production console. Every engine
      // spells it differently, and it was `pg_terminate_backend` for all three
      // — a statement that simply errors on the other two, typed by someone
      // whose migration is already stuck.
      const advice = (await texts(panel.page, '.queue-blocker')).pop() ?? '';
      assert.match(advice, /The oldest has been there/);
      assert.match(advice, /SELECT pg_terminate_backend\(4821\);/);
    });

    it('says KILL on MySQL and killOp on MongoDB', async () => {
      await panel.send({ ...begin, engine: 'mysql' });
      await panel.send(finding({ queuedBehind: blockers }));
      assert.match((await texts(panel.page, '.queue-blocker')).pop() ?? '', /KILL 4821;/);

      await panel.send({ ...begin, engine: 'mongo' });
      await panel.send(finding({ queuedBehind: blockers }));
      assert.match((await texts(panel.page, '.queue-blocker')).pop() ?? '', /db\.killOp\(4821\)/);

      // Back to Postgres for the tests below.
      await panel.send(begin);
      await panel.send(finding({ queuedBehind: blockers }));
    });

    it('says a session is holding it, rather than 1 sessions are', async () => {
      await panel.send(begin);
      await panel.send(finding({ queuedBehind: [blockers[1]] }));

      const warning = (await panel.page.textContent('.queue-warning')) ?? '';
      assert.match(warning, /A session is holding/);
      assert.doesNotMatch(warning, /1 sessions/);
    });

    it('replaces the quiet lock note rather than printing both', async () => {
      // Saying "this takes a SHARE lock" underneath "this will queue behind a
      // fourteen-minute report" buries the part that matters.
      await panel.send(begin);
      await panel.send(
        finding({
          lock: { level: 'SHARE', blocks: 'writes', brief: false },
          queuedBehind: blockers,
        }),
      );

      assert.equal(await count(panel.page, '.queue-warning'), 1);
      assert.equal(await count(panel.page, '.lock-note'), 0);
    });
  });

  describe('the safer way to write it', () => {
    const rewrites = [
      {
        title: 'Build it without the lock',
        rationale: 'A plain CREATE INDEX holds a lock that blocks every write for the whole build.',
        statements: ['CREATE INDEX CONCURRENTLY ON orders (user_id)'],
        needsSeparateTransactions: true,
      },
    ];

    it('offers the rewrite, with the reason and the statement', async () => {
      await panel.send(begin);
      await panel.send(finding({ rewrites }));

      assert.equal(await count(panel.page, '.rewrite'), 1);
      assert.match((await panel.page.textContent('.rewrite-title')) ?? '', /without the lock/);
      assert.match((await panel.page.textContent('.rewrite-why')) ?? '', /blocks every write/);
      assert.match(
        (await panel.page.textContent('.rewrite-sql')) ?? '',
        /CREATE INDEX CONCURRENTLY ON orders \(user_id\);/,
      );
    });

    it('warns when it cannot all run in one transaction', async () => {
      // CONCURRENTLY cannot, and a migration tool that wraps everything in one
      // fails on it — a worse surprise than the lock was.
      assert.match(
        (await panel.page.textContent('.rewrite-warn')) ?? '',
        /cannot all run in one transaction/,
      );
    });

    it('puts it on the clipboard when asked', async () => {
      await panel.page.evaluate(`
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: function (value) { window.__copied.push(value); return Promise.resolve(); }
          }
        });
      `);

      await panel.page.click('.rewrite-actions button:text-is("Copy")');

      const copied = (await panel.page.evaluate('window.__copied')) as string[];
      assert.equal(copied.length, 1);
      assert.match(copied[0]!, /CREATE INDEX CONCURRENTLY/);
    });

    it('asks the editor to put it in the file', async () => {
      await panel.page.click('.rewrite-actions button:text-is("Replace in file")');

      const posted = (await panel.posted()) as {
        type?: string;
        index?: number;
        statements?: string[];
      }[];
      const asked = posted.filter((message) => message.type === 'applyRewrite').pop();

      assert.ok(asked, 'Replace in file posted nothing at all');
      assert.equal(asked.index, 0);
      assert.deepEqual(asked.statements, ['CREATE INDEX CONCURRENTLY ON orders (user_id)']);
    });

    it('offers nothing when there is nothing better to suggest', async () => {
      await panel.send(begin);
      await panel.send(finding({ rewrites: [] }));
      assert.equal(await count(panel.page, '.rewrite'), 0);
    });
  });

  describe('a number that is an estimate', () => {
    it('marks it as one, rather than letting it read as a count', async () => {
      // Every other number in this panel was measured. This one was not, and
      // the difference has to be visible or the measured ones mean less.
      await panel.send(begin);
      await panel.send(finding({ estimated: true }));

      assert.equal(await count(panel.page, '.detail.estimated'), 1);
    });

    it('leaves a measured number unmarked', async () => {
      await panel.send(begin);
      await panel.send(finding({ estimated: false }));
      assert.equal(await count(panel.page, '.detail.estimated'), 0);
    });
  });
});
