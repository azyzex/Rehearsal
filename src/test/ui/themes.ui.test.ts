import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  indexPanelHtml,
  previewPanelHtml,
  schemaPanelHtml,
  sidebarHtml,
} from '../../panel/html';
import { Panel, Theme, closeBrowser, openPanel } from '../support/uiHarness';

/**
 * Every panel, in both themes, with every word checked.
 *
 * Until now every UI test rendered against stand-ins for Dark+, which means all
 * of them tested half the problem. The bug this harness was built for — a Drop
 * button whose label was the same colour as its background — is a light-theme
 * bug as easily as a dark one, and light is where this stylesheet's fallbacks
 * have never once been exercised.
 *
 * So rather than duplicating each panel's tests, this walks every element that
 * paints text and asks one question of all of them: can you read it. A sweep
 * finds the control nobody thought to write a test for, which is exactly the
 * kind that shipped last time.
 */

/** Below this a person cannot read the text at the sizes these panels use. */
const MINIMUM_CONTRAST = 3;

/**
 * Contrast for everything with its own words, reported all at once.
 *
 * One assertion per element would stop at the first failure and hide the other
 * nine. The whole list is the useful output.
 *
 * The browser-side half is built as a plain string with no escapes in it at
 * all. A regex written inside a TypeScript template literal loses its
 * backslashes before the browser ever sees it, which produced a checker that
 * reported every element on the page as unreadable and was itself the only
 * thing broken.
 */
async function unreadable(panel: Panel): Promise<string[]> {
  const script = [
    '(function () {',
    '  function parse(value) {',
    '    var nums = [];',
    '    var current = "";',
    '    for (var i = 0; i < value.length; i++) {',
    '      var ch = value[i];',
    '      if ((ch >= "0" && ch <= "9") || ch === ".") { current += ch; }',
    '      else if (current.length) { nums.push(Number(current)); current = ""; }',
    '    }',
    '    if (current.length) { nums.push(Number(current)); }',
    '',
    '    var rgba = [nums[0] || 0, nums[1] || 0, nums[2] || 0, nums.length > 3 ? nums[3] : 1];',
    '    // color-mix() comes back as color(srgb 0.64 0.48 0.16): channels in',
    '    // 0..1 rather than 0..255. Read as bytes, a readable colour looks',
    '    // like near-black, which is a fault in the ruler.',
    '    if (value.slice(0, 6) === "color(") {',
    '      rgba[0] *= 255; rgba[1] *= 255; rgba[2] *= 255;',
    '    }',
    '    return rgba;',
    '  }',
    '',
    '  // What the eye sees behind an element: every translucent layer',
    '  // composited onto the first opaque one. Returning the topmost',
    '  // translucent layer as if it were solid reported a 22% tint as a solid',
    '  // block of colour, which is how this checker invented three bugs.',
    '  function backgroundOf(node) {',
    '    var layers = [];',
    '    var current = node;',
    '    var base = null;',
    '',
    '    while (current) {',
    '      var rgba = parse(getComputedStyle(current).backgroundColor);',
    '      if (rgba[3] >= 0.999) { base = rgba; break; }',
    '      if (rgba[3] > 0.001) { layers.push(rgba); }',
    '      current = current.parentElement;',
    '    }',
    '',
    '    if (!base) {',
    '      var root = parse(getComputedStyle(document.documentElement).backgroundColor);',
    '      base = root[3] >= 0.999 ? root : [255, 255, 255, 1];',
    '    }',
    '',
    '    // Furthest layer first, so each one paints over what is already there.',
    '    var out = [base[0], base[1], base[2]];',
    '    for (var k = layers.length - 1; k >= 0; k--) {',
    '      var a = layers[k][3];',
    '      out[0] = layers[k][0] * a + out[0] * (1 - a);',
    '      out[1] = layers[k][1] * a + out[1] * (1 - a);',
    '      out[2] = layers[k][2] * a + out[2] * (1 - a);',
    '    }',
    '    return [out[0], out[1], out[2], 1];',
    '  }',
    '',
    '  function channel(v) {',
    '    var s = v / 255;',
    '    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);',
    '  }',
    '  function luminance(rgb) {',
    '    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);',
    '  }',
    '  function ratio(a, b) {',
    '    var x = luminance(a), y = luminance(b);',
    '    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);',
    '  }',
    '',
    '  var bad = [];',
    '  var all = document.querySelectorAll("body *");',
    '',
    '  for (var i = 0; i < all.length; i++) {',
    '    var el = all[i];',
    '',
    '    // Only elements holding their own words. A wrapper inherits its',
    '    // children\'s text and would be counted twice.',
    '    var own = "";',
    '    for (var j = 0; j < el.childNodes.length; j++) {',
    '      if (el.childNodes[j].nodeType === 3) { own += el.childNodes[j].textContent; }',
    '    }',
    '    if (own.trim().length === 0) { continue; }',
    '',
    '    var box = el.getBoundingClientRect();',
    '    var style = getComputedStyle(el);',
    '    if (box.width === 0 || box.height === 0) { continue; }',
    '    if (style.visibility === "hidden" || style.display === "none") { continue; }',
    '',
    '    var opacity = Number(style.opacity);',
    '    if (!isFinite(opacity)) { opacity = 1; }',
    '    if (opacity < 0.05) { continue; }',
    '',
    '    var front = parse(style.color);',
    '    var back = backgroundOf(el);',
    '',
    '    // Fade the foreground toward its background by its own alpha and any',
    '    // opacity on the element, which is what the eye actually sees.',
    '    var alpha = front[3] * opacity;',
    '    var seen = [',
    '      front[0] * alpha + back[0] * (1 - alpha),',
    '      front[1] * alpha + back[1] * (1 - alpha),',
    '      front[2] * alpha + back[2] * (1 - alpha)',
    '    ];',
    '',
    '    var r = ratio(seen, back);',
    '    if (r < ' + String(MINIMUM_CONTRAST) + ') {',
    '      var name = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");',
    '      if (el.className && typeof el.className === "string") {',
    '        name += "." + el.className.split(" ").filter(Boolean).join(".");',
    '      }',
    '      bad.push(name + " \\"" + own.trim().slice(0, 30) + "\\" at " + r.toFixed(2));',
    '    }',
    '  }',
    '  return bad;',
    '})()',
  ].join('\n');

  return panel.page.evaluate(script) as Promise<string[]>;
}

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
      columns: [column('id', 'integer', { isPrimaryKey: true, nullable: false }), column('email')],
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
        column('user_id', 'integer'),
        column('status'),
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

const EMPTY_DIFF = { tables: [], columns: [], relationships: [], dataEdits: 0 };

describe('every panel, in both themes', () => {
  after(async () => {
    await closeBrowser();
  });

  for (const theme of ['dark', 'light'] as Theme[]) {
    describe(theme, () => {
      it('the sidebar has no unreadable text', async () => {
        const panel = await openPanel(sidebarHtml, { width: 300, height: 900, theme });
        try {
          await panel.send({
            type: 'state',
            connected: null,
            saved: [
              { id: 'a', label: 'shop on neon.tech', engine: 'postgres', lastUsed: '2026-08-25' },
              { id: 'b', label: 'blog on localhost', engine: 'mysql', lastUsed: '2026-08-24' },
              { id: 'c', label: 'events on atlas', engine: 'mongo', lastUsed: '2026-08-23' },
            ],
          });
          await panel.send({
            type: 'detected',
            detection: {
              engine: 'mongo',
              connectionString: 'mongodb://localhost:27017/x',
              label: 'x on localhost',
              inferred: true,
              notes: ['Previews need a replica set.'],
            },
          });
          await panel.send({ type: 'failed', message: 'Nothing is listening at 127.0.0.1:5432.' });

          assert.deepEqual(await unreadable(panel), []);
          await panel.shot(`sidebar-${theme}`);
        } finally {
          await panel.close();
        }
      });

      it('the connected sidebar has no unreadable text', async () => {
        const panel = await openPanel(sidebarHtml, { width: 300, height: 900, theme });
        try {
          await panel.send({
            type: 'state',
            connected: {
              label: 'shop on ep-cool.neon.tech',
              engine: 'mysql',
              engineName: 'MySQL',
              source: 'chosen in the sidebar',
              transactionalDdl: false,
            },
            saved: [],
          });
          assert.deepEqual(await unreadable(panel), []);
        } finally {
          await panel.close();
        }
      });

      it('the preview panel has no unreadable text', async () => {
        const panel = await openPanel(previewPanelHtml, { width: 900, height: 900, theme });
        try {
          await panel.send({
            type: 'begin',
            file: 'migrations/0002.sql',
            connection: 'shop@neon',
            statements: [
              { index: 0, sql: 'ALTER TABLE users DROP COLUMN phone', startLine: 0, endLine: 0 },
              { index: 1, sql: 'UPDATE orders SET status = $1', startLine: 2, endLine: 2 },
            ],
          });

          for (const [index, severity, headline] of [
            [0, 'destructive', 'Will destroy data'],
            [1, 'caution', 'Changes 1,927 rows'],
          ] as [number, string, string][]) {
            await panel.send({
              type: 'finding',
              finding: {
                statementIndex: index,
                kind: index === 0 ? 'drop_column' : 'update',
                classification: { kind: index === 0 ? 'drop_column' : 'update', table: 'users' },
                severity,
                headline,
                detail: '40,072 rows have a value in phone.',
                rowCount: 40_072,
                tableRows: 50_000,
                ...(index === 1
                  ? {
                      triggers: [
                        {
                          name: 'announce',
                          table: 'orders',
                          timing: 'after',
                          events: ['update'],
                          functionName: 'announce',
                          enabled: true,
                          escapes: ['sends a notification (pg_notify / NOTIFY)'],
                        },
                      ],
                    }
                  : {}),
              },
            });
          }

          await panel.send({
            type: 'offenders',
            statementIndex: 0,
            offenders: {
              kind: 'null',
              table: 'users',
              column: 'phone',
              total: 40_072,
              rows: [{ id: '1', email: 'a@example.com', phone: '+15550001' }],
              fix: {
                title: 'Back it up first',
                sql: 'CREATE TABLE backup AS SELECT id, phone FROM users',
                needsEditing: false,
                note: 'Keeps the values somewhere the drop cannot reach.',
              },
            },
          });

          await panel.send({
            type: 'references',
            statementIndex: 0,
            scan: {
              summary: '3 mentions of users.phone in 2 files.',
              total: 3,
              references: [
                { file: 'src/user.ts', line: 42, text: 'user.phone', form: 'phone' },
              ],
            },
          });

          await panel.send({ type: 'done', summary: '1 would destroy data. Out of 2 statements.' });

          assert.deepEqual(await unreadable(panel), []);
          await panel.shot(`preview-${theme}`);
        } finally {
          await panel.close();
        }
      });

      it('the index panel has no unreadable text', async () => {
        const panel = await openPanel(indexPanelHtml, { width: 900, height: 800, theme });
        try {
          const candidate = {
            table: 'orders',
            columns: ['user_id', 'status'],
            reason: 'orders is read end to end — 300,000 rows examined to return 4.',
            sql: 'CREATE INDEX ON "orders" ("user_id", "status")',
          };

          await panel.send({ type: 'begin', query: 'SELECT id FROM orders', connection: 'shop' });
          await panel.send({ type: 'candidates', results: [{ candidate }, { candidate }] });
          await panel.send({
            type: 'result',
            index: 0,
            result: {
              candidate,
              experiment: {
                method: 'hypothetical',
                used: true,
                beforeCost: 5886.46,
                afterCost: 19.64,
                note: 'Estimated, not timed.',
              },
            },
          });
          await panel.send({
            type: 'result',
            index: 1,
            result: { candidate, error: 'permission denied for table orders' },
          });
          await panel.send({ type: 'done', summary: '1 of 2 would be used.' });

          assert.deepEqual(await unreadable(panel), []);
          await panel.shot(`indexes-${theme}`);
        } finally {
          await panel.close();
        }
      });

      it('the schema explorer has no unreadable text', async () => {
        const panel = await openPanel(schemaPanelHtml, { width: 1200, height: 900, theme });
        try {
          await panel.send({ type: 'schema', snapshot: SNAPSHOT, connection: 'shop@neon' });
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
              sample: [{ id: '1', email: 'a@example.com' }],
              sampleRaw: [{ id: 1, email: 'a@example.com' }],
            },
          });
          await panel.send({
            type: 'changeset',
            changes: [
              { index: 0, label: 'Drop column status from orders', sql: 'ALTER TABLE orders DROP COLUMN status' },
            ],
            diff: EMPTY_DIFF,
            projected: SNAPSHOT,
            sql: '',
          });
          await panel.send({
            type: 'preview',
            summary: '1 would destroy data.',
            destructive: true,
            blocking: false,
            canApply: true,
            findings: [
              {
                statementIndex: 0,
                kind: 'drop_column',
                classification: { kind: 'drop_column', table: 'orders', column: 'status' },
                severity: 'destructive',
                headline: 'Will destroy data',
                detail: '298,412 rows have a value in status.',
              },
            ],
            affected: { orders: 'destructive' },
          });

          assert.deepEqual(await unreadable(panel), []);
          await panel.shot(`schema-${theme}`);
        } finally {
          await panel.close();
        }
      });
    });
  }
});
