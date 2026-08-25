import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { indexPanelHtml } from '../../panel/html';
import { Panel, closeBrowser, contrast, count, openPanel, texts, visible } from '../support/uiHarness';

/**
 * The index panel, rendered.
 *
 * This panel is almost entirely a picture: two bars on one scale, and a word
 * saying whether the planner would use the thing. A cost that drops by two
 * orders of magnitude and one that drops by four per cent are the same sentence
 * in English and obviously different pictures, which is the whole reason it is
 * drawn — so a test that only checks the numbers arrived has tested the least
 * interesting half.
 */

const CANDIDATES = [
  {
    candidate: {
      table: 'orders',
      columns: ['user_id', 'status'],
      reason: 'orders is read end to end — 300,000 rows examined to return 4.',
      sql: 'CREATE INDEX ON "orders" ("user_id", "status")',
    },
  },
  {
    candidate: {
      table: 'orders',
      columns: ['total_cents'],
      reason: 'orders is scanned in full and the filter tests total_cents.',
      sql: 'CREATE INDEX ON "orders" ("total_cents")',
    },
  },
];

describe('the index panel, rendered', () => {
  let panel: Panel;

  before(async () => {
    panel = await openPanel(indexPanelHtml, { width: 900, height: 760 });
    await panel.send({
      type: 'begin',
      query: "SELECT id FROM orders WHERE user_id = 4242 AND status = 'paid'",
      connection: 'shop@neon',
    });
    await panel.send({ type: 'candidates', results: CANDIDATES });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  it('loads without throwing', () => {
    assert.deepEqual(panel.problems, []);
  });

  it('shows the query it is testing against', async () => {
    assert.match(
      (await panel.page.textContent('#query')) ?? '',
      /SELECT id FROM orders WHERE user_id = 4242/,
    );
  });

  it('draws a card per candidate, pending until tested', async () => {
    assert.equal(await count(panel.page, '.row'), 2);
    assert.deepEqual(await texts(panel.page, '.badge'), ['Testing…', 'Testing…']);
  });

  describe('once the planner has answered', () => {
    before(async () => {
      await panel.send({
        type: 'result',
        index: 0,
        result: {
          ...CANDIDATES[0],
          experiment: {
            method: 'hypothetical',
            used: true,
            beforeCost: 5886.46,
            afterCost: 19.64,
            note: 'Estimated, not timed: the index was never built.',
          },
        },
      });
      await panel.send({
        type: 'result',
        index: 1,
        result: {
          ...CANDIDATES[1],
          experiment: {
            method: 'hypothetical',
            used: false,
            beforeCost: 5886.46,
            afterCost: 5886.46,
            note: 'Estimated, not timed: the index was never built.',
          },
        },
      });
      await panel.send({ type: 'done', summary: '1 of 2 would be used. Nothing was built.' });
    });

    it('says which one the planner would reach for', async () => {
      assert.deepEqual(await texts(panel.page, '.badge'), ['Used', 'Planner ignores it']);
    });

    it('draws the improvement to scale, not just as a number', async () => {
      // The bar is the argument. 5886 to 19.6 has to look like almost nothing
      // next to almost everything.
      const widths = (await panel.page.evaluate(`
        (function () {
          var card = document.querySelectorAll('.row')[0];
          var fills = card.querySelectorAll('.compare-fill');
          return Array.prototype.map.call(fills, function (fill) {
            var track = fill.parentElement.getBoundingClientRect().width;
            return fill.getBoundingClientRect().width / track;
          });
        })()
      `)) as number[];

      assert.equal(widths.length, 2, 'a bar for now and a bar for with the index');
      assert.ok(widths[0]! > 0.95, `the "now" bar should fill the track, got ${widths[0]}`);
      assert.ok(widths[1]! < 0.05, `the "with the index" bar should be tiny, got ${widths[1]}`);
    });

    it('puts the size of the win in words as well', async () => {
      const change = await panel.page.textContent('.row:nth-of-type(1) .compare-change');
      assert.match(change ?? '', /×\s*cheaper/, `read: ${change}`);
    });

    it('does not claim an improvement where there is none', async () => {
      const change = await panel.page.textContent('.row:nth-of-type(2) .compare-change');
      assert.match(change ?? '', /No change/);
    });

    it('is readable throughout', async () => {
      for (const selector of ['.row:nth-of-type(1) .badge', '.compare-value', '.compare-change']) {
        const ratio = await contrast(panel.page, selector);
        assert.ok(ratio >= 3, `${selector} has contrast ${ratio.toFixed(2)}`);
      }
    });

    it('offers the statement three ways, all of them readable', async () => {
      const buttons = await texts(panel.page, '.row:nth-of-type(1) .rewrite-actions button');
      assert.deepEqual(buttons, ['Copy', 'Copy as CONCURRENTLY', 'Add to file']);

      for (const nth of [1, 2, 3]) {
        const selector = `.row:nth-of-type(1) .rewrite-actions button:nth-of-type(${nth})`;
        assert.equal(await visible(panel.page, selector), true);
        assert.ok((await contrast(panel.page, selector)) >= 3);
      }
    });

    it('makes its buttons look like buttons', async () => {
      // They took their border from --vscode-panel-border, which in Dark+ is
      // #2b2b2b on a #1f1f1f background: invisible. A transparent background
      // and an invisible border renders a button as a piece of text, and
      // people do not click text.
      const painted = (await panel.page.evaluate(`
        (function () {
          var button = document.querySelector('.row:nth-of-type(1) .rewrite-actions button');
          var style = getComputedStyle(button);
          return {
            background: style.backgroundColor,
            borderColor: style.borderTopColor,
            borderWidth: style.borderTopWidth
          };
        })()
      `)) as { background: string; borderColor: string; borderWidth: string };

      const invisible = (colour: string): boolean =>
        colour === 'transparent' || /,\s*0\s*\)$/.test(colour);

      const hasSurface = !invisible(painted.background);
      const hasBorder = !invisible(painted.borderColor) && parseFloat(painted.borderWidth) > 0;

      assert.ok(
        hasSurface || hasBorder,
        `the button paints nothing of its own: ${JSON.stringify(painted)}`,
      );

    });

    it('asks the extension to write it into the file', async () => {
      await panel.click('.row:nth-of-type(1) .rewrite-actions button:nth-of-type(3)');
      const posted = (await panel.posted()) as { type?: string; sql?: string }[];
      const insert = posted.find((message) => message.type === 'insertIndex');

      assert.ok(insert, 'clicking did nothing');
      assert.match(insert!.sql ?? '', /CREATE INDEX ON "orders" \("user_id", "status"\)/);
    });

    it('says what was measured and what was not', async () => {
      assert.match(
        (await panel.page.textContent('.row:nth-of-type(1) .sample-note')) ?? '',
        /Estimated, not timed/,
      );
      assert.match(
        (await panel.page.textContent('#summary')) ?? '',
        /1 of 2 would be used\. Nothing was built\./,
      );
    });
  });

  it('shows a failure rather than an empty card', async () => {
    await panel.send({
      type: 'result',
      index: 1,
      result: { ...CANDIDATES[1], error: 'permission denied for table orders' },
    });

    assert.match(
      (await panel.page.textContent('.row:nth-of-type(2)')) ?? '',
      /permission denied/,
    );
  });

  it('nothing threw at any point', () => {
    assert.deepEqual(panel.problems, []);
  });

  it('looks like this', async () => {
    await panel.shot('index-panel');
  });
});
