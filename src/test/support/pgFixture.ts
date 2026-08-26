import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from 'pg';

/**
 * A real Postgres for the test suite.
 *
 * The spec is explicit that the database must not be mocked: the entire value
 * proposition is that the numbers come from a real server executing the real
 * statement. `testcontainers` is the spec's suggestion, but it needs Docker,
 * which is not available on every dev machine. `embedded-postgres` downloads
 * the actual Postgres binaries and runs a throwaway cluster, which satisfies
 * the same requirement without a container runtime.
 */

export interface PostgresFixture {
  readonly connectionString: string;
  stop(): Promise<void>;
}

const DB_NAME = 'dryrun_test';

/**
 * How long one attempt at a cluster gets.
 *
 * Generous: initdb on a cold cache takes seconds, and the suite runs several of
 * these at once. This is the number at which something is wrong, not the number
 * at which it is slow.
 */
const START_TIMEOUT_MS = 90_000;

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * A port nothing is listening on, from the operating system.
 *
 * This used to be `5000 + random(10000)`. Twenty-three test files each start
 * one of these and `node --test` runs files in parallel, which is a birthday
 * problem with about a one-in-forty chance of two of them choosing the same
 * port — and the loser fails in a `before` hook, which cancels every test
 * under it and reads as a broken feature rather than as a collision. The range
 * also overlapped whatever else the machine had listening on 5000–15000.
 *
 * Binding to port 0 and asking what was assigned leaves a gap between closing
 * this socket and Postgres opening one, so the caller still retries.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

export async function startPostgres(): Promise<PostgresFixture> {
  // `embedded-postgres` is ESM-only, so it is loaded dynamically from our CJS build.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  let last: unknown;

  // Three tries, because a free port can stop being free between asking for
  // one and using it. Anything that fails all three is a real fault.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await freePort();
    const databaseDir = path.join(os.tmpdir(), `dryrun-pg-${process.pid}-${port}`);

    const pg = new EmbeddedPostgres({
      databaseDir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => {
        /* quiet */
      },
      onError: () => {
        /* quiet; failures surface as thrown errors */
      },
    });

    try {
      // Under a timeout, because a start that hangs hangs forever otherwise:
      // the retry below only fires on a throw, and an embedded cluster
      // struggling for memory on a loaded machine does not throw, it waits.
      // That took the whole suite down for twenty minutes with no output.
      await withTimeout(
        (async () => {
          await pg.initialise();
          await pg.start();
          await pg.createDatabase(DB_NAME);
        })(),
        START_TIMEOUT_MS,
        'starting the cluster',
      );

      const connectionString = `postgresql://postgres:postgres@localhost:${port}/${DB_NAME}`;
      await seed(connectionString);

      return {
        connectionString,
        stop: async () => {
          await pg.stop();
        },
      };
    } catch (error) {
      last = error;
      // A half-started cluster leaves its data directory behind, and these are
      // hundreds of megabytes each. Cleaning up here is the only chance.
      await pg.stop().catch(() => undefined);
      await fs.rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  throw new Error(
    `could not start a Postgres fixture in three attempts: ${
      last instanceof Error ? last.message : String(last)
    }`,
  );
}

/**
 * Fixture schema per spec §15. Small enough to seed in well under a second,
 * shaped to exercise every probe: a partially-null column, duplicate values,
 * orphan rows, and a column that is entirely null.
 */
async function seed(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE users (
        id            serial PRIMARY KEY,
        email         text,
        tier          text NOT NULL DEFAULT 'free',
        phone_number  text,
        nickname      text,
        org_id        int
      );

      CREATE TABLE orgs (
        id   serial PRIMARY KEY,
        name text NOT NULL
      );

      INSERT INTO orgs (name) VALUES ('acme'), ('globex');

      -- 12 users with no email       -> SET NOT NULL must report 12 failures
      -- duplicate emails             -> ADD UNIQUE must report duplicates
      -- org_id 99 has no matching org -> ADD FOREIGN KEY must report orphans
      -- nickname is never set        -> DROP COLUMN nickname must report 'safe'
      INSERT INTO users (email, tier, phone_number, org_id)
      SELECT
        CASE WHEN i <= 12 THEN NULL
             WHEN i <= 20 THEN 'dupe@example.com'
             ELSE 'user' || i || '@example.com' END,
        CASE WHEN i % 3 = 0 THEN 'pro' ELSE 'free' END,
        CASE WHEN i % 2 = 0 THEN '+1555000' || i ELSE NULL END,
        CASE WHEN i > 90 THEN 99 ELSE 1 + (i % 2) END
      FROM generate_series(1, 100) AS i;

      -- Real databases have autovacuum keeping the catalog statistics current.
      -- A fixture that skips this is not a smaller version of production, it is
      -- a different thing: reltuples stays at -1 and every size-derived answer
      -- is measured against a table the planner believes is unknown.
      ANALYZE orgs, users;
    `);
  } finally {
    await client.end();
  }
}
