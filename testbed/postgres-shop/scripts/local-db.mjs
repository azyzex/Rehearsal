#!/usr/bin/env node
/**
 * Starts a local Postgres for driving the extension by hand, seeds it, writes
 * the .env files, and stays running until Ctrl+C.
 *
 *   npm run testbed:db
 *
 * This exists so you can press F5 and see the panel without waiting on a cloud
 * signup. It reuses the Postgres binaries `embedded-postgres` already
 * downloaded for the test suite, so there is nothing new to install.
 *
 * It is not a replacement for the Neon database. Latency is part of what the
 * panel's per-row loading behaviour is meant to handle, and you only see that
 * against a real remote. Use this for fast iteration, Neon for the demo.
 */

import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, '..');
const ROOT = path.join(PROJECT, '..', '..');

const PORT = 54329;
const DB = 'dryrun_shop';
const DATA_DIR = path.join(os.tmpdir(), 'dryrun-local-pg');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });

  const firstRun = !existsSync(path.join(DATA_DIR, 'PG_VERSION'));

  if (firstRun) {
    process.stdout.write('Initialising a local Postgres cluster (first run only)… ');
    await pg.initialise();
    console.log('done');
  }

  await pg.start();
  if (firstRun) {
    await pg.createDatabase(DB);
  }

  const url = `postgresql://postgres:postgres@localhost:${PORT}/${DB}`;
  console.log(`\nPostgres is up on port ${PORT}.\n`);

  // Seed through the same script the cloud path uses, so this is never a
  // different shape of data from what the Neon instructions produce.
  await run(
    process.execPath,
    [
      path.join(HERE, 'setup.mjs'),
      '--url',
      url,
      '--users',
      arg('--users', '50000'),
      '--orders',
      arg('--orders', '300000'),
    ],
    { cwd: ROOT, stdio: 'inherit' },
  ).then(({ stdout }) => process.stdout.write(stdout));

  for (const target of [path.join(ROOT, '.env'), path.join(PROJECT, '.env')]) {
    if (existsSync(target)) {
      console.log(`\nLeaving ${path.relative(ROOT, target)} alone — it already exists.`);
      continue;
    }
    writeFileSync(target, `DATABASE_URL=${url}\n`, 'utf8');
    console.log(`Wrote ${path.relative(ROOT, target)}`);
  }

  console.log(
    `\nReady. Press F5 in VS Code, open testbed/postgres-shop/migrations/0007_update.sql\n` +
      `in the new window, and run "Dry Run: Preview" (Ctrl+Alt+D).\n\n` +
      `Leave this terminal open — the database stops when you Ctrl+C here.`,
  );

  const shutdown = async () => {
    console.log('\nStopping Postgres…');
    await pg.stop().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Hold the process open.
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
