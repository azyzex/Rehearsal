import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sidebarHtml } from '../../panel/html';
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
 * The view in the activity bar, rendered.
 *
 * This is the first thing anyone sees, and until it existed the first thing
 * anyone saw was a command palette and a `.env` file they had not written. So
 * these are mostly about the connect step: that typing produces an answer, that
 * the answer is right, and that nothing about it reaches the network.
 *
 * The sidebar is narrow — 300px is the common width — so it is rendered at that
 * width rather than at a comfortable one.
 */

const SAVED = [
  { id: 'a', label: 'shop on ep-cool-mode.neon.tech', engine: 'postgres', lastUsed: '2026-08-25' },
  { id: 'b', label: 'blog on localhost', engine: 'mysql', lastUsed: '2026-08-24' },
  { id: 'c', label: 'analytics on cluster0.mongodb.net', engine: 'mongo', lastUsed: '2026-08-23' },
];

describe('the sidebar, rendered', () => {
  let panel: Panel;

  before(async () => {
    panel = await openPanel(sidebarHtml, { width: 300, height: 820 });
    await panel.send({ type: 'state', connected: null, saved: SAVED });
  });

  after(async () => {
    await panel.close();
    await closeBrowser();
  });

  it('loads without throwing', () => {
    assert.deepEqual(panel.problems, []);
  });

  it('asks for a connection before anything else', async () => {
    assert.equal(await visible(panel.page, '#connect'), true);
    assert.equal(await visible(panel.page, '#ready'), false);
    assert.equal(await visible(panel.page, '#connection'), true);
  });

  it('says what it does, once, in a sentence', async () => {
    assert.match(
      (await panel.page.textContent('.lede')) ?? '',
      /reads, measures, and rolls everything back/,
    );
  });

  it('announces itself on load, so the extension can fill it in', async () => {
    const posted = (await panel.posted()) as { type?: string }[];
    assert.ok(posted.some((message) => message.type === 'ready'));
  });

  describe('typing a connection string', () => {
    it('asks for a detection on every keystroke', async () => {
      await panel.page.fill('#connection', 'postgresql://u:p@db.example.com/shop');
      await panel.page.waitForTimeout(30);

      const posted = (await panel.posted()) as { type?: string; value?: string }[];
      const detect = posted.filter((message) => message.type === 'detect');

      assert.ok(detect.length > 0, 'nothing was asked');
      assert.match(detect[detect.length - 1]!.value ?? '', /db\.example\.com/);
    });

    it('shows which database it is, and where', async () => {
      await panel.send({
        type: 'detected',
        detection: {
          engine: 'postgres',
          connectionString: 'postgresql://u:p@db.example.com/shop',
          label: 'shop on db.example.com',
          inferred: false,
          notes: [],
        },
      });

      assert.equal(await visible(panel.page, '#detected'), true);
      assert.equal(await panel.page.textContent('.badge-engine'), 'PostgreSQL');
      assert.match((await panel.page.textContent('.detected-label')) ?? '', /shop on db/);
    });

    it('says when the engine was a guess rather than a fact', async () => {
      await panel.send({
        type: 'detected',
        detection: {
          engine: 'mysql',
          connectionString: 'mysql://localhost:3306/blog',
          label: 'blog on localhost',
          inferred: true,
          notes: [],
        },
      });

      assert.match((await panel.page.textContent('.detected-guess')) ?? '', /guessed from the port/);
    });

    it('shows the conditions worth knowing before connecting', async () => {
      await panel.send({
        type: 'detected',
        detection: {
          engine: 'mongo',
          connectionString: 'mongodb://localhost:27017/analytics',
          label: 'analytics on localhost',
          inferred: false,
          notes: ['Previews need a replica set. MongoDB rolls back with a transaction.'],
        },
      });

      assert.equal(await count(panel.page, '.note'), 1);
      assert.match((await panel.page.textContent('.note')) ?? '', /replica set/);
    });

    it('refuses to connect with something it cannot read', async () => {
      await panel.send({
        type: 'detected',
        detection: {
          engine: 'postgres',
          connectionString: 'redis://localhost',
          label: '',
          inferred: false,
          problem: 'Dry Run does not know the "redis" scheme.',
          notes: [],
        },
      });

      assert.match((await panel.page.textContent('#detected')) ?? '', /does not know/);
      assert.equal(
        await panel.page.getAttribute('#go', 'disabled'),
        '',
        'the button is disabled rather than left to fail',
      );
    });

    it('re-enables once the string is readable again', async () => {
      await panel.send({
        type: 'detected',
        detection: {
          engine: 'postgres',
          connectionString: 'postgresql://db/shop',
          label: 'shop on db',
          inferred: false,
          notes: [],
        },
      });
      assert.equal(await panel.page.getAttribute('#go', 'disabled'), null);
    });

    it('connects when the button is pressed', async () => {
      await panel.click('#go');
      const posted = (await panel.posted()) as { type?: string; remember?: boolean }[];
      const connect = posted.find((message) => message.type === 'connect');

      assert.ok(connect, 'clicking did nothing');
      assert.equal(connect!.remember, true, 'remembering is the default');
    });
  });

  describe('the saved list', () => {
    it('shows one row per saved connection', async () => {
      assert.equal(await count(panel.page, '.saved-row'), 3);
      assert.deepEqual(await texts(panel.page, '.saved-name'), SAVED.map((s) => s.label));
    });

    it('colours each by engine, so the list reads without being read', async () => {
      const badges = await texts(panel.page, '.saved-row .badge-engine');
      assert.deepEqual(badges, ['PG', 'SQL', 'MDB']);

      const colours = (await panel.page.evaluate(`
        Array.prototype.map.call(
          document.querySelectorAll('.saved-row .badge-engine'),
          function (badge) { return getComputedStyle(badge).backgroundColor; }
        )
      `)) as string[];
      assert.equal(new Set(colours).size, 3, `all three are ${colours.join(', ')}`);
    });

    it('connects to one when clicked', async () => {
      await panel.click('.saved-row:nth-of-type(2) .saved-open');
      const posted = (await panel.posted()) as { type?: string; id?: string }[];
      assert.ok(posted.some((message) => message.type === 'connectSaved' && message.id === 'b'));
    });

    it('forgets one when asked', async () => {
      await panel.click('.saved-row:nth-of-type(1) .saved-forget');
      const posted = (await panel.posted()) as { type?: string; id?: string }[];
      assert.ok(posted.some((message) => message.type === 'forget' && message.id === 'a'));
    });

    it('keeps a long label from pushing the buttons off the edge', async () => {
      // The sidebar is 300px and a Neon hostname is longer than that.
      const overflow = (await panel.page.evaluate(`
        (function () {
          var row = document.querySelector('.saved-row');
          var body = document.body;
          return row.getBoundingClientRect().right > body.getBoundingClientRect().right + 1;
        })()
      `)) as boolean;

      assert.equal(overflow, false, 'a row is wider than the sidebar');
    });
  });

  describe('once connected', () => {
    before(async () => {
      await panel.send({
        type: 'state',
        connected: {
          label: 'shop on ep-cool-mode.neon.tech',
          engine: 'postgres',
          engineName: 'PostgreSQL',
          source: 'chosen in the sidebar',
          transactionalDdl: true,
        },
        saved: SAVED,
      });
    });

    it('swaps the form for the launcher', async () => {
      assert.equal(await visible(panel.page, '#ready'), true);
      assert.equal(await visible(panel.page, '#connect'), false);
    });

    it('says what it is connected to', async () => {
      assert.match(
        (await panel.page.textContent('#connected-label')) ?? '',
        /shop on ep-cool-mode/,
      );
      assert.equal(await panel.page.textContent('#connected-engine'), 'PostgreSQL');
    });

    it('says nothing about DDL on a database that can undo it', async () => {
      assert.equal(await visible(panel.page, '#connected-note'), false);
    });

    it('offers every action, each with a reason', async () => {
      const actions = await count(panel.page, '.action');
      assert.ok(actions >= 7, `only ${actions} actions`);

      const reasons = await texts(panel.page, '.action-why');
      assert.equal(reasons.filter((reason) => reason.length === 0).length, 0);
    });

    it('runs one when clicked', async () => {
      await panel.click('.action[data-command="dryrun.exploreSchema"]');
      const posted = (await panel.posted()) as { type?: string; command?: string }[];
      assert.ok(
        posted.some(
          (message) => message.type === 'run' && message.command === 'dryrun.exploreSchema',
        ),
      );
    });

    it('is readable throughout', async () => {
      for (const selector of ['#connected-label', '.action-name', '.action-why', '#footer']) {
        const ratio = await contrast(panel.page, selector);
        assert.ok(ratio >= 3, `${selector} has contrast ${ratio.toFixed(2)}`);
      }
    });

    it('warns about the engine that cannot undo a schema change', async () => {
      await panel.send({
        type: 'state',
        connected: {
          label: 'blog on localhost',
          engine: 'mysql',
          engineName: 'MySQL',
          source: 'chosen in the sidebar',
          transactionalDdl: false,
        },
        saved: SAVED,
      });

      assert.equal(await visible(panel.page, '#connected-note'), true);
      assert.match(
        (await panel.page.textContent('#connected-note')) ?? '',
        /commits schema changes the moment they run/,
      );
    });

    it('says the MongoDB version of the same thing', async () => {
      await panel.send({
        type: 'state',
        connected: {
          label: 'analytics on cluster0',
          engine: 'mongo',
          engineName: 'MongoDB',
          source: 'chosen in the sidebar',
          transactionalDdl: false,
        },
        saved: SAVED,
      });

      assert.match(
        (await panel.page.textContent('#connected-note')) ?? '',
        /cannot run in a transaction here/,
      );
    });
  });

  it('shows a failure without losing what was typed', async () => {
    await panel.send({ type: 'state', connected: null, saved: SAVED });
    await panel.page.fill('#connection', 'postgresql://nope/shop');
    await panel.send({ type: 'failed', message: 'password authentication failed' });

    assert.equal(await visible(panel.page, '#error'), true);
    assert.match((await panel.page.textContent('#error')) ?? '', /password authentication/);
    assert.equal(
      await panel.page.inputValue('#connection'),
      'postgresql://nope/shop',
      'a failed attempt does not clear the box',
    );
  });

  it('never shows an empty red box', async () => {
    // The bug a screenshot found. An AggregateError carries no message of its
    // own, the panel set textContent to '', and the result was a coloured
    // rectangle with nothing in it — which tells the reader less than no
    // rectangle would have. errors.ts stops most of these from arriving empty;
    // this is the guard for the ones that still do.
    for (const message of ['', '   ', undefined, null]) {
      await panel.send({ type: 'state', connected: null, saved: SAVED });
      await panel.send({ type: 'failed', message });

      assert.equal(await visible(panel.page, '#error'), true);
      const text = ((await panel.page.textContent('#error')) ?? '').trim();
      assert.ok(text.length > 0, `empty box for ${JSON.stringify(message)}`);
      assert.match(text, /said nothing about why/);
    }
  });

  it('shows a real message when there is one', async () => {
    await panel.send({
      type: 'failed',
      message: 'Nothing is listening at 127.0.0.1:54329.',
    });
    assert.match((await panel.page.textContent('#error')) ?? '', /Nothing is listening/);
  });

  it('nothing threw at any point', () => {
    assert.deepEqual(panel.problems, []);
  });

  it('looks like this', async () => {
    await panel.send({ type: 'state', connected: null, saved: SAVED });
    await panel.page.fill('#connection', 'postgresql://user:pw@ep-cool.neon.tech/shop');
    await panel.send({
      type: 'detected',
      detection: {
        engine: 'postgres',
        connectionString: 'postgresql://user:pw@ep-cool.neon.tech/shop',
        label: 'shop on ep-cool.neon.tech',
        inferred: false,
        notes: [],
      },
    });
    await panel.shot('sidebar-connect');

    await panel.send({
      type: 'state',
      connected: {
        label: 'shop on ep-cool.neon.tech',
        engine: 'postgres',
        engineName: 'PostgreSQL',
        source: 'chosen in the sidebar',
        transactionalDdl: true,
      },
      saved: SAVED,
    });
    await panel.shot('sidebar-connected');
  });
});
