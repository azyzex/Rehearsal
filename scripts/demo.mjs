/**
 * The demo recording, made rather than filmed.
 *
 * Every number in the resulting GIF is measured. This starts a real Postgres,
 * seeds it with enough rows to be worth talking about, runs the real analysis
 * over a real migration file, and then feeds the real findings to the real
 * panel markup — the same `previewPanelHtml`, the same stylesheet, the same
 * scripts the editor loads. Frames are captured as the rows arrive, which is
 * how the panel genuinely behaves: each row appears when its statement
 * finishes measuring.
 *
 * It is not a screen recording. There is no editor chrome around it and no
 * cursor, because there is no editor — it is the panel, rendered at the size
 * the panel opens at. A recording made in a real window is still better and
 * PUBLISHING.md says so; this exists so that the README is not empty while
 * that is waiting to happen, and so the numbers in it can never be invented.
 *
 *   npm run demo
 *
 * Writes media/demo.gif. Needs nothing installed beyond the dev dependencies:
 * the encoder is the ffmpeg that ships inside Playwright.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

// gifenc is CommonJS, so its exports arrive on the default.
const { GIFEncoder, applyPalette, quantize } = gifenc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'media', 'demo.gif');
const FRAMES = path.join(os.tmpdir(), `rehearsal-demo-${process.pid}`);

/** 16:10ish, and the width a panel opens at beside an editor. */
const WIDTH = 720;
const HEIGHT = 460;

/**
 * The migration. Chosen so the four severities all appear, because the point
 * of the panel is that it distinguishes them — a demo of four green rows
 * demonstrates nothing.
 */
const MIGRATION = `ALTER TABLE users DROP COLUMN phone_number;

ALTER TABLE users ALTER COLUMN email SET NOT NULL;

CREATE INDEX idx_orders_status ON orders (status);

ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
`;

async function main() {
  const { startPostgres } = await import(
    pathToFileURL(path.join(ROOT, 'out', 'test', 'support', 'pgFixture.js')).href
  );
  const { PostgresAdapter } = await import(
    pathToFileURL(path.join(ROOT, 'out', 'adapters', 'postgres.js')).href
  );
  const { analyzeStatements } = await import(
    pathToFileURL(path.join(ROOT, 'out', 'analysis', 'orchestrator.js')).href
  );
  const { languageFor } = await import(
    pathToFileURL(path.join(ROOT, 'out', 'parser', 'language.js')).href
  );
  const { previewPanelHtml } = await import(
    pathToFileURL(path.join(ROOT, 'out', 'panel', 'html.js')).href
  );
  const harness = await import(
    pathToFileURL(path.join(ROOT, 'out', 'test', 'support', 'uiHarness.js')).href
  );
  const { Client } = await import('pg');

  console.log('starting a real Postgres…');
  const fixture = await startPostgres();

  try {
    console.log('seeding it with something worth measuring…');
    const client = new Client({ connectionString: fixture.connectionString });
    await client.connect();

    // The fixture's own seed is 100 rows, which is right for a test and wrong
    // for a demo: "12 of 100" does not land the way "40,072 of 50,000" does.
    // These are inserted, not invented — every figure on screen is counted off
    // this table.
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status text;
      TRUNCATE users RESTART IDENTITY CASCADE;

      INSERT INTO users (email, tier, phone_number, nickname, org_id, status)
      SELECT
        CASE WHEN i % 4000 = 0 THEN NULL
             ELSE 'user' || i || '@example.com' END,
        CASE WHEN i % 3 = 0 THEN 'pro' ELSE 'free' END,
        CASE WHEN i % 5 <> 0 THEN '+1555' || lpad(i::text, 7, '0') END,
        NULL,
        1 + (i % 2),
        'active'
      FROM generate_series(1, 50000) AS i;

      CREATE TABLE IF NOT EXISTS orders (
        id      serial PRIMARY KEY,
        user_id int REFERENCES users(id),
        status  text NOT NULL DEFAULT 'pending',
        total   numeric(10,2) NOT NULL DEFAULT 0
      );
      TRUNCATE orders RESTART IDENTITY;
      INSERT INTO orders (user_id, status, total)
      SELECT 1 + (i % 50000),
             CASE WHEN i % 7 = 0 THEN 'shipped' ELSE 'pending' END,
             (i % 400)::numeric
      FROM generate_series(1, 300000) AS i;

      ANALYZE users, orders;
    `);
    await client.end();

    console.log('measuring the migration for real…');
    const adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 60_000,
      lockTimeoutMs: 5000,
      applicationName: 'vscode-rehearsal',
    });

    const language = languageFor('postgres');
    const statements = language.split(MIGRATION);
    const findings = [];

    await analyzeStatements({
      adapter,
      statements,
      thresholds: {
        cautionRows: 100,
        destructiveRows: 1000,
        largeTable: 100_000,
        sampleSize: 5,
        explainAnalyze: false,
      },
      onFinding: (finding) => {
        console.log(
          `  ${finding.severity.padEnd(11)} ${finding.headline} — ${finding.detail.slice(0, 72)}`,
        );
        findings.push(finding);
      },
    });

    await adapter.dispose();

    if (findings.length === 0) {
      throw new Error('nothing was measured; refusing to draw a demo of nothing');
    }

    console.log('rendering the real panel…');
    fs.rmSync(FRAMES, { recursive: true, force: true });
    fs.mkdirSync(FRAMES, { recursive: true });

    const panel = await harness.openPanel(previewPanelHtml, {
      width: WIDTH,
      height: HEIGHT,
      theme: 'dark',
    });

    let frame = 0;
    /** Holds the current picture for `count` frames, so the GIF can breathe. */
    const hold = async (count) => {
      for (let i = 0; i < count; i += 1) {
        await panel.page.screenshot({
          path: path.join(FRAMES, `${String(frame).padStart(4, '0')}.png`),
        });
        frame += 1;
      }
    };

    await panel.send({
      type: 'begin',
      file: 'migrations/0007_update.sql',
      connection: 'shop on staging',
      engine: 'postgres',
      statements: statements.map((statement) => ({
        index: statement.index,
        sql: statement.sql,
        startLine: statement.startLine,
        endLine: statement.endLine,
      })),
    });

    // The empty panel, waiting. Short: nobody needs to look at it.
    await hold(4);

    // Then the rows, one at a time, which is how they really arrive.
    for (const finding of findings) {
      await panel.send({ type: 'finding', finding: JSON.parse(JSON.stringify(finding)) });
      await hold(7);
    }

    await panel.send({
      type: 'done',
      summary: summarise(findings, statements.length),
    });

    // A beat on the verdict line, then a scroll to the bottom. Four rows do
    // not fit in a panel this tall, and the alternative to scrolling is either
    // a shorter migration — which is a demo of less — or a frame so long
    // nobody reaches the end of it.
    await hold(14);

    // The still is taken here rather than at the end: the verdict line with
    // the destructive row under it is the strongest single frame, and a
    // social card or a reader with animation off gets one frame only.
    const stillFrame = frame - 1;

    const scrollable = await panel.page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return Math.max(0, el.scrollHeight - el.clientHeight);
    });

    const steps = 20;
    for (let i = 1; i <= steps; i += 1) {
      // Eased, so it reads as a hand moving rather than a jump cut.
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await panel.page.evaluate((top) => {
        (document.scrollingElement ?? document.documentElement).scrollTop = top;
      }, Math.round(scrollable * eased));
      await hold(1);
    }

    // And a long pause at the bottom, because that is the frame someone
    // scrolling past a README actually stops on.
    await hold(20);

    await panel.close();
    await harness.closeBrowser();

    console.log(`encoding ${frame} frames…`);
    encode(FRAMES, OUT, WIDTH, HEIGHT);

    // The finished panel on its own, for anywhere that will not animate a GIF
    // — a social preview card, or a reader with animation turned off.
    fs.copyFileSync(
      path.join(FRAMES, `${String(stillFrame).padStart(4, '0')}.png`),
      path.join(ROOT, 'media', 'demo-still.png'),
    );

    const size = fs.statSync(OUT).size;
    console.log(`wrote ${path.relative(ROOT, OUT)} — ${(size / 1024).toFixed(0)} KB`);
    if (size > 5 * 1024 * 1024) {
      console.warn('that is over 5 MB; GitHub will be slow to load it');
    }
  } finally {
    await fixture.stop().catch(() => undefined);
    fs.rmSync(FRAMES, { recursive: true, force: true });
  }
}

/** The same sentence the extension writes above the rows. */
function summarise(findings, total) {
  const destructive = findings.filter((f) => f.severity === 'destructive').length;
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  if (destructive === 0 && blocking === 0) {
    return `${total} statements, nothing destructive found.`;
  }
  const parts = [];
  if (destructive > 0) parts.push(`${destructive} would destroy data`);
  if (blocking > 0) parts.push(`${blocking} would fail`);
  return `${parts.join(', ')}, out of ${total} statements.`;
}

/**
 * Frames to GIF, in pure JavaScript.
 *
 * Playwright ships an ffmpeg, and it is built `--disable-everything`: no GIF
 * muxer, no palettegen filter, and not even the image2 demuxer needed to read
 * a numbered sequence. So the encoding is done here instead, which costs two
 * small dev dependencies and no paid tool.
 *
 * One palette for the whole animation rather than one per frame. The panel is
 * a fixed set of greys and four severity colours, so a shared palette is both
 * smaller and steadier — a per-frame palette makes the background shimmer as
 * rows arrive.
 */
function encode(frames, out, width, height) {
  const files = fs
    .readdirSync(frames)
    .filter((name) => name.endsWith('.png'))
    .sort();

  if (files.length === 0) {
    throw new Error('no frames were captured');
  }

  const pixels = files.map((name) => {
    const png = PNG.sync.read(fs.readFileSync(path.join(frames, name)));
    if (png.width !== width || png.height !== height) {
      throw new Error(`frame ${name} is ${png.width}x${png.height}, expected ${width}x${height}`);
    }
    return new Uint8ClampedArray(png.data);
  });

  // Built from the last frame, which is the one with every colour in it: all
  // four severities are on screen by then.
  const palette = quantize(pixels[pixels.length - 1], 256, { format: 'rgb565' });
  const gif = GIFEncoder();

  for (const frame of pixels) {
    gif.writeFrame(applyPalette(frame, palette, 'rgb565'), width, height, {
      palette,
      // 12 frames a second, expressed the way a GIF does: hundredths.
      delay: 84,
    });
  }

  gif.finish();
  fs.writeFileSync(out, Buffer.from(gif.bytes()));
}

await main();
