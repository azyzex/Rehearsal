import type { Connection } from 'mysql2/promise';

/**
 * A real MySQL for the test suite.
 *
 * Same principle as the Postgres fixture: the entire value of this extension is
 * that the numbers come from a real server running the real statement, so a
 * mocked driver would be testing the mock. `mysql-memory-server` downloads
 * actual mysqld binaries and runs a throwaway instance, which is the same
 * bargain `embedded-postgres` makes and works without a container runtime.
 *
 * Booting is slow — several seconds the first time, while the binaries are
 * fetched — so the instance is shared across every test file that asks for it
 * and shut down once at the end.
 */

export interface MysqlFixture {
  readonly connectionString: string;
  readonly database: string;
  connect(): Promise<Connection>;
  stop(): Promise<void>;
}

let shared: Promise<MysqlFixture> | undefined;

export function startMysql(): Promise<MysqlFixture> {
  if (!shared) {
    shared = boot();
  }
  return shared;
}

async function boot(): Promise<MysqlFixture> {
  // Both are ESM-only, so they are loaded dynamically from our CJS build.
  const { createDB } = await import('mysql-memory-server');
  const mysql = await import('mysql2/promise');

  const server = await createDB({
    username: 'root',
    // Quiet unless something actually fails.
    logLevel: 'ERROR',
  });

  const connectionString =
    `mysql://${server.username}@127.0.0.1:${server.port}/${server.dbName}`;

  return {
    connectionString,
    database: server.dbName,
    connect: () =>
      mysql.createConnection({
        host: '127.0.0.1',
        port: server.port,
        user: server.username,
        database: server.dbName,
        multipleStatements: true,
      }),
    stop: async () => {
      await server.stop();
      shared = undefined;
    },
  };
}

/**
 * The fixture schema, shaped to exercise every probe.
 *
 * Mirrors the Postgres fixture deliberately — the same twelve nulls, the same
 * eight duplicates, the same ten orphans — so that a difference in a test
 * result between the two adapters is a difference in the adapter rather than a
 * difference in what it was pointed at.
 */
export async function seedMysql(connection: Connection): Promise<void> {
  await connection.query(`
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS orgs;

    CREATE TABLE orgs (
      id   int AUTO_INCREMENT PRIMARY KEY,
      name varchar(100) NOT NULL
    ) ENGINE=InnoDB;

    CREATE TABLE users (
      id            int AUTO_INCREMENT PRIMARY KEY,
      email         varchar(255) NULL,
      tier          varchar(20) NOT NULL DEFAULT 'free',
      phone_number  varchar(40) NULL,
      nickname      varchar(40) NULL,
      org_id        int NULL
    ) ENGINE=InnoDB;

    INSERT INTO orgs (name) VALUES ('acme'), ('globex');
  `);

  // Generated row by row rather than with a recursive CTE: the same seed then
  // works on MySQL 5.7, and the fixture is a hundred rows.
  const values: string[] = [];
  for (let i = 1; i <= 100; i += 1) {
    const email =
      i <= 12 ? 'NULL' : i <= 20 ? `'dupe@example.com'` : `'user${i}@example.com'`;
    const tier = i % 3 === 0 ? `'pro'` : `'free'`;
    const phone = i % 2 === 0 ? `'+1555000${i}'` : 'NULL';
    const org = i > 90 ? 99 : 1 + (i % 2);
    values.push(`(${email}, ${tier}, ${phone}, ${org})`);
  }

  await connection.query(
    `INSERT INTO users (email, tier, phone_number, org_id) VALUES ${values.join(', ')}`,
  );

  // Real databases have statistics kept current. A fixture that skips this is
  // not a smaller version of production, it is a different thing.
  await connection.query('ANALYZE TABLE users, orgs');
}
