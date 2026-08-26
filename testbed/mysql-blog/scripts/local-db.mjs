#!/usr/bin/env node
/**
 * Starts a local MySQL for driving the extension by hand, seeds it, writes the
 * .env file, and stays running until Ctrl+C.
 *
 *   npm run testbed:mysql
 *
 * This exists so that trying MySQL does not require enabling a Windows service
 * as an administrator, or knowing the root password of one installed years ago.
 * It reuses the `mysqld` binaries `mysql-memory-server` already downloaded for
 * the test suite, so there is nothing new to install and nothing needing
 * elevation.
 *
 * The seed is deliberately small by default. The full testbed is 400,000
 * comments, which is the right size for seeing lock warnings and the wrong size
 * to wait on before you have looked at a single panel. Pass --comments to grow
 * it.
 */

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, '..');
const ROOT = path.join(PROJECT, '..', '..');

const PORT = 54331;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const { createDB } = await import('mysql-memory-server');

  process.stdout.write('Downloading mysqld if needed and starting it… ');
  const server = await createDB({
    username: 'root',
    dbName: 'blog',
    logLevel: 'ERROR',
    // Pinned, so a connection saved in the sidebar still works tomorrow. The
    // library's default is 0, meaning "any free one" — right for a test suite
    // running four at once, useless for something you save and come back to.
    // If it is busy the library walks to the next free port, so the string
    // below is read back off the server rather than assumed.
    port: PORT,
  });
  console.log('done');

  if (server.port !== PORT) {
    console.log(`\nPort ${PORT} was busy, so this one is on ${server.port}.`);
  }

  const url = `mysql://${server.username}@127.0.0.1:${server.port}/${server.dbName}`;
  console.log(`\nMySQL is up on port ${server.port}.\n`);

  // Seeded through the same script the "real MySQL" path uses, so this is never
  // a different shape of data from what those instructions produce.
  const seeded = await run(
    process.execPath,
    [
      path.join(HERE, 'setup.mjs'),
      '--url',
      url,
      '--authors',
      arg('--authors', '2000'),
      '--posts',
      arg('--posts', '6000'),
      '--comments',
      arg('--comments', '20000'),
    ],
    { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 },
  );
  process.stdout.write(seeded.stdout);

  // Rewritten rather than left alone. This server keeps nothing between runs,
  // so a .env from last time names a port with nothing listening on it — which
  // arrives as "connection refused" and reads as the extension being broken.
  const envFile = path.join(PROJECT, '.env');
  writeFileSync(envFile, `DATABASE_URL=${url}\n`, 'utf8');
  console.log(`\nWrote ${path.relative(ROOT, envFile)}`);

  console.log(
    `\nConnection string (paste this into the Dry Run sidebar):\n\n  ${url}\n\n` +
      `The engine badge should say MySQL before you press Connect, and once you\n` +
      `are connected the sidebar should warn that MySQL commits schema changes\n` +
      `the moment they run. That warning is the whole difference from Postgres.\n\n` +
      `Leave this terminal open — the database stops when you Ctrl+C here.`,
  );

  const shutdown = async () => {
    console.log('\nStopping MySQL…');
    await server.stop().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
