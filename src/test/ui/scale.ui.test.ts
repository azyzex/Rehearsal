import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { previewPanelHtml, schemaPanelHtml } from '../../panel/html';
import { closeBrowser, count, openPanel, visible } from '../support/uiHarness';

/**
 * A schema the size of a real one.
 *
 * The testbed has twenty-one tables and every test so far has used five. A
 * production schema has two hundred, and the whole claim of this extension is
 * that you can see your database — so the size at which the picture stops
 * being drawable is a number worth knowing rather than discovering.
 *
 * The layout is a force-directed simulation, which is the part that gets
 * expensive: it is quadratic in the number of nodes unless something stops it.
 */

function schemaOf(tableCount: number, keysPerTable = 1) {
  const tables = Array.from({ length: tableCount }, (_, index) => ({
    schema: 'public',
    name: `table_${index}`,
    qualified: `table_${index}`,
    rows: (index + 1) * 1000,
    bytes: (index + 1) * 100_000,
    partitioned: false,
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'name', type: 'text', nullable: true, isPrimaryKey: false },
      { name: 'parent_id', type: 'integer', nullable: true, isPrimaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, isPrimaryKey: false },
    ],
  }));

  const foreignKeys = [];
  for (let index = 1; index < tableCount; index += 1) {
    for (let n = 0; n < keysPerTable; n += 1) {
      const target = (index * (n + 7)) % index;
      foreignKeys.push({
        name: `fk_${index}_${n}`,
        fromTable: `table_${index}`,
        fromColumns: ['parent_id'],
        toTable: `table_${target}`,
        toColumns: ['id'],
      });
    }
  }

  return { schemas: ['public'], tables, foreignKeys };
}

/** How long the page took between the message arriving and the cards existing. */
async function drawTime(panel: Awaited<ReturnType<typeof openPanel>>, snapshot: unknown) {
  const started = Date.now();
  await panel.send({ type: 'schema', snapshot, connection: 'big@somewhere' });
  return Date.now() - started;
}

describe('a schema the size of a real one', () => {
  after(async () => {
    await closeBrowser();
  });

  it('draws two hundred tables without falling over', async () => {
    const panel = await openPanel(schemaPanelHtml, { width: 1400, height: 900 });
    try {
      const elapsed = await drawTime(panel, schemaOf(200));

      assert.deepEqual(panel.problems, []);
      assert.equal(await count(panel.page, '.table'), 200);
      // Generous, because this is a headless browser on whatever machine is
      // running the suite. It is here to catch a change that makes the layout
      // quadratic again, not to police tenths of a second.
      assert.ok(elapsed < 20_000, `took ${elapsed}ms to draw 200 tables`);
    } finally {
      await panel.close();
    }
  });

  it('says when there is more schema than fits legibly', async () => {
    // Two hundred tables draw in a quarter of a second and fit on screen as an
    // unreadable knot. Pretending that is a picture of the database wastes the
    // time it takes someone to zoom in and find out otherwise.
    const panel = await openPanel(schemaPanelHtml, { width: 1400, height: 900 });
    try {
      await panel.send({ type: 'schema', snapshot: schemaOf(200), connection: 'big@somewhere' });

      assert.equal(await visible(panel.page, '#crowded'), true);
      const text = (await panel.page.textContent('#crowded')) ?? '';
      assert.match(text, /200 tables/);
      assert.match(text, /focus mode/, 'and points at what does work');
    } finally {
      await panel.close();
    }
  });

  it('says nothing about it at a size that reads fine', async () => {
    const panel = await openPanel(schemaPanelHtml, { width: 1400, height: 900 });
    try {
      await panel.send({ type: 'schema', snapshot: schemaOf(12), connection: 'small@somewhere' });
      assert.equal(await visible(panel.page, '#crowded'), false);
    } finally {
      await panel.close();
    }
  });

  it('lays them out somewhere rather than in a heap', async () => {
    const panel = await openPanel(schemaPanelHtml, { width: 1400, height: 900 });
    try {
      await panel.send({ type: 'schema', snapshot: schemaOf(200), connection: 'big@somewhere' });

      const distinct = (await panel.page.evaluate(`
        (function () {
          var seen = {};
          var cards = document.querySelectorAll('.table');
          for (var i = 0; i < cards.length; i++) {
            var box = cards[i].getBoundingClientRect();
            seen[Math.round(box.x) + ',' + Math.round(box.y)] = true;
          }
          return Object.keys(seen).length;
        })()
      `)) as number;

      // A layout that stacks everything at one point renders, passes every
      // static check, and is unusable.
      assert.ok(distinct > 150, `only ${distinct} distinct positions for 200 cards`);
    } finally {
      await panel.close();
    }
  });

  it('draws an edge per relationship at that size', async () => {
    const panel = await openPanel(schemaPanelHtml, { width: 1400, height: 900 });
    try {
      const snapshot = schemaOf(120, 2);
      await panel.send({ type: 'schema', snapshot, connection: 'big@somewhere' });

      const edges = await count(panel.page, '#edges path, #edges line');
      assert.ok(
        edges >= snapshot.foreignKeys.length * 0.9,
        `${edges} edges for ${snapshot.foreignKeys.length} relationships`,
      );
      assert.deepEqual(panel.problems, []);
    } finally {
      await panel.close();
    }
  });

  it('still answers a search at that size', async () => {
    const panel = await openPanel(schemaPanelHtml, { width: 1400, height: 900 });
    try {
      await panel.send({ type: 'schema', snapshot: schemaOf(200), connection: 'big@somewhere' });

      const started = Date.now();
      await panel.page.fill('#search', 'table_137');
      await panel.page.waitForTimeout(120);
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 5000, `search took ${elapsed}ms`);
      assert.deepEqual(panel.problems, []);
    } finally {
      await panel.close();
    }
  });

  it('marks a preview across many tables without slowing to a stop', async () => {
    const panel = await openPanel(schemaPanelHtml, { width: 1400, height: 900 });
    try {
      await panel.send({ type: 'schema', snapshot: schemaOf(200), connection: 'big@somewhere' });

      const affected: Record<string, string> = {};
      for (let index = 0; index < 40; index += 1) {
        affected[`table_${index * 3}`] = index % 2 === 0 ? 'destructive' : 'caution';
      }

      const started = Date.now();
      await panel.send({
        type: 'preview',
        summary: 'lots',
        destructive: true,
        blocking: false,
        canApply: false,
        findings: [],
        affected,
      });
      const elapsed = Date.now() - started;

      assert.equal(await count(panel.page, '.table.affected'), 40);
      assert.ok(elapsed < 5000, `marking took ${elapsed}ms`);
    } finally {
      await panel.close();
    }
  });
});

describe('a migration file the size of a real one', () => {
  after(async () => {
    await closeBrowser();
  });

  it('renders three hundred statements without choking', async () => {
    // A generated migration — a framework rewriting every table — is long, and
    // the panel adds a row at a time as each finding resolves.
    const panel = await openPanel(previewPanelHtml, { width: 1000, height: 900 });
    try {
      const statements = Array.from({ length: 300 }, (_, index) => ({
        index,
        sql: `ALTER TABLE table_${index} ADD COLUMN added_at timestamptz`,
        startLine: index,
        endLine: index,
      }));

      await panel.send({ type: 'begin', file: 'big.sql', connection: 'big', statements });

      const started = Date.now();
      for (let index = 0; index < 300; index += 1) {
        await panel.send({
          type: 'finding',
          finding: {
            statementIndex: index,
            kind: 'add_column',
            classification: { kind: 'add_column', table: `table_${index}`, column: 'added_at' },
            severity: index % 10 === 0 ? 'destructive' : 'safe',
            headline: index % 10 === 0 ? 'Will destroy data' : 'Safe',
            detail: 'Adding a nullable column touches no existing rows.',
          },
        });
      }
      const elapsed = Date.now() - started;

      assert.equal(await count(panel.page, '.row'), 300);
      assert.deepEqual(panel.problems, []);
      // Every finding re-renders the list, which is fine at twenty rows and is
      // the thing to watch at three hundred.
      assert.ok(elapsed < 30_000, `${elapsed}ms to add 300 findings one at a time`);
    } finally {
      await panel.close();
    }
  });

  it('keeps the summary visible at the bottom of a long list', async () => {
    const panel = await openPanel(previewPanelHtml, { width: 1000, height: 900 });
    try {
      const statements = Array.from({ length: 100 }, (_, index) => ({
        index,
        sql: `DELETE FROM table_${index}`,
        startLine: index,
        endLine: index,
      }));

      await panel.send({ type: 'begin', file: 'big.sql', connection: 'big', statements });
      await panel.send({ type: 'done', summary: '100 statements, nothing destructive found.' });

      assert.equal(await visible(panel.page, '#summary'), true);
    } finally {
      await panel.close();
    }
  });
});
