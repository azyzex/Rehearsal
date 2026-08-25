import type { Db, MongoClient } from 'mongodb';

/**
 * A real MongoDB for the test suite.
 *
 * A replica set rather than a standalone server, and not for realism's sake:
 * multi-document transactions need one, and a transaction is the only thing
 * standing between a preview and an apply. A fixture without one could not test
 * the single property this adapter exists to guarantee.
 *
 * One node is enough. The election is instant and the transaction semantics are
 * the same ones a three-node set or an Atlas cluster provides.
 */

export interface MongoFixture {
  readonly uri: string;
  readonly database: string;
  client(): MongoClient;
  db(): Db;
  stop(): Promise<void>;
}

const DB_NAME = 'dryrun_test';

let shared: Promise<MongoFixture> | undefined;

export function startMongo(): Promise<MongoFixture> {
  if (!shared) {
    shared = boot();
  }
  return shared;
}

async function boot(): Promise<MongoFixture> {
  // Both are ESM-only, so they are loaded dynamically from our CJS build.
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const { MongoClient } = await import('mongodb');

  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  // getUri takes the database name rather than being concatenated with it:
  // the URI ends in `/?replicaSet=…`, so appending would land the name inside
  // the query string and the client would never find the replica set.
  const uri = server.getUri(DB_NAME);
  const client = new MongoClient(server.getUri());
  await client.connect();

  return {
    uri,
    database: DB_NAME,
    client: () => client,
    db: () => client.db(DB_NAME),
    stop: async () => {
      await client.close().catch(() => undefined);
      await server.stop();
      shared = undefined;
    },
  };
}

/**
 * The fixture data, shaped like the SQL ones.
 *
 * The same twelve without an email, the same eight sharing one, the same ten
 * pointing at an org that does not exist — so that a difference in a result
 * between the three adapters is a difference in the adapter rather than in
 * what it was pointed at. What differs is what MongoDB allows: some documents
 * are missing the field entirely rather than holding null, because that is a
 * distinction this database has and the others do not.
 */
export async function seedMongo(db: Db): Promise<void> {
  await db.dropDatabase();

  await db.collection('orgs').insertMany([
    { _id: 1 as unknown as never, name: 'acme' },
    { _id: 2 as unknown as never, name: 'globex' },
  ]);

  const users: Record<string, unknown>[] = [];
  for (let i = 1; i <= 100; i += 1) {
    const user: Record<string, unknown> = {
      _id: i,
      tier: i % 3 === 0 ? 'pro' : 'free',
      org_id: i > 90 ? 99 : 1 + (i % 2),
    };

    // Twelve without an email: six holding null, six missing the field. Both
    // mean "no value", and only MongoDB can tell them apart.
    if (i > 12) {
      user['email'] = i <= 20 ? 'dupe@example.com' : `user${i}@example.com`;
    } else if (i <= 6) {
      user['email'] = null;
    }

    if (i % 2 === 0) {
      user['phone_number'] = `+1555000${i}`;
    }

    users.push(user);
  }

  await db.collection('users').insertMany(users as never[]);

  await db.collection('orders').insertMany(
    Array.from({ length: 40 }, (_, index) => ({
      _id: index + 1,
      user_id: 1 + (index % 20),
      status: index % 4 === 0 ? 'paid' : 'pending',
      total_cents: (index + 1) * 100,
    })) as never[],
  );
}
