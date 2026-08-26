#!/usr/bin/env node
/**
 * Starts a local MongoDB replica set for driving the extension by hand, seeds
 * it, writes the .env file, and stays running until Ctrl+C.
 *
 *   npm run testbed:mongo
 *
 * A replica set rather than a standalone, and not for realism's sake: previews
 * need multi-document transactions, a standalone `mongod` does not have them,
 * and Dry Run refuses to connect to one rather than run something it could not
 * undo. So a standalone would leave you looking at the refusal instead of the
 * feature.
 *
 * One node is enough. The election is instant and the transaction semantics are
 * the ones a three-node set or an Atlas cluster provides.
 *
 * This exists so that trying MongoDB does not require an Atlas signup, an IP
 * allowlist and a cloud user before you can see a single panel. It reuses the
 * `mongod` binaries `mongodb-memory-server` already downloaded for the test
 * suite, so there is nothing new to install.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, '..');
const ROOT = path.join(PROJECT, '..', '..');

const PORT = 54330;
const DB = 'analytics';

// Kept out of the OS temp sweep, so the data survives a reboot and a second run
// starts in a second rather than reseeding two hundred thousand documents.
const DATA_DIR = path.join(os.homedir(), '.dryrun', 'local-mongo');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');

  mkdirSync(DATA_DIR, { recursive: true });
  const firstRun = !existsSync(path.join(DATA_DIR, 'storage.bson'));

  if (firstRun) {
    process.stdout.write('Downloading mongod if needed and starting a replica set… ');
  }

  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: PORT, dbPath: DATA_DIR, storageEngine: 'wiredTiger' }],
  });

  if (firstRun) {
    console.log('done');
  }

  // getUri takes the database name rather than being concatenated with it: the
  // URI ends in `/?replicaSet=…`, so appending would land the name inside the
  // query string and the driver would never find the set.
  const url = server.getUri(DB);
  console.log(`\nMongoDB is up on port ${PORT}, as a single-node replica set.\n`);

  // Seeded through the same script the Atlas path uses, so this is never a
  // different shape of data from what the cloud instructions produce.
  const seeded = await run(
    process.execPath,
    [path.join(HERE, 'setup.mjs'), '--url', url, '--db', arg('--db', DB)],
    { cwd: ROOT },
  );
  process.stdout.write(seeded.stdout);

  // Rewritten rather than left alone: the port is pinned but the replica set
  // name is chosen by the library, so a .env from an older run can name a set
  // this server does not answer to — which fails as a timeout rather than as
  // anything that says what is wrong.
  const envFile = path.join(PROJECT, '.env');
  writeFileSync(envFile, 'DATABASE_URL=' + url + String.fromCharCode(10), 'utf8');
  console.log(String.fromCharCode(10) + 'Wrote ' + path.relative(ROOT, envFile));

  console.log(
    `\nConnection string (paste this into the Dry Run sidebar):\n\n  ${url}\n\n` +
      `The engine badge should say MongoDB before you press Connect.\n` +
      `Then open testbed/mongo-analytics as a folder and try Explore Schema.\n\n` +
      `Leave this terminal open — the database stops when you Ctrl+C here.`,
  );

  const shutdown = async () => {
    console.log('\nStopping MongoDB…');
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
