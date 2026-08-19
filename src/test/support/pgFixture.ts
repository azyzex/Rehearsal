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

export async function startPostgres(): Promise<PostgresFixture> {
  // `embedded-postgres` is ESM-only, so it is loaded dynamically from our CJS build.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const port = 5000 + Math.floor(Math.random() * 10_000);
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

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);

  const connectionString = `postgresql://postgres:postgres@localhost:${port}/${DB_NAME}`;
  await seed(connectionString);

  return {
    connectionString,
    stop: async () => {
      await pg.stop();
    },
  };
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
    `);
  } finally {
    await client.end();
  }
}
