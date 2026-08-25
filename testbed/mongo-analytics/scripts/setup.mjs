#!/usr/bin/env node
/**
 * Seeds the MongoDB testbed.
 *
 *   node testbed/mongo-analytics/scripts/setup.mjs --url "mongodb+srv://user:pass@cluster.mongodb.net/analytics"
 *
 * Mongo needs a replica set for multi-document transactions, which is what the
 * rollback mechanism depends on. Atlas gives you one on the free tier; a plain
 * local `mongod` does not, and the preview will refuse there.
 */

const EVENTS = 200_000;
const SESSIONS = 40_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadDriver() {
  try {
    return (await import('mongodb')).MongoClient;
  } catch {
    throw new Error(
      'mongodb is not installed:\n  npm install --save-dev mongodb',
    );
  }
}

async function main() {
  const url = arg('--url') ?? process.env.MONGO_URL;
  if (!url) {
    throw new Error('Pass --url "mongodb+srv://…" or set MONGO_URL.');
  }
  if (/prod|production|live/i.test(url.replace(/\/\/[^@]*@/, '//'))) {
    throw new Error('Refusing to seed: this connection looks like production, and this script drops collections.');
  }

  const MongoClient = await loadDriver();
  const client = new MongoClient(url);
  await client.connect();

  try {
    const db = client.db(arg('--db', 'analytics'));

    const isReplicaSet = await db
      .admin()
      .command({ hello: 1 })
      .then((info) => Boolean(info.setName))
      .catch(() => false);

    await db.collection('events').drop().catch(() => {});
    await db.collection('sessions').drop().catch(() => {});

    // A third of events carry no user_id, which is what makes a later
    // "required field" migration interesting.
    const events = Array.from({ length: EVENTS }, (_, i) => ({
      _id: i + 1,
      name: ['view', 'click', 'purchase', 'signup'][i % 4],
      user_id: i % 3 === 0 ? null : 1 + (i % SESSIONS),
      // Present on old documents only — the schemaless equivalent of a column
      // someone believes is unused.
      legacy_utm: i % 5 === 0 ? `utm-${i}` : undefined,
      revenue_cents: i % 4 === 2 ? (i * 37) % 40000 : 0,
      created_at: new Date(Date.now() - (i % 720) * 3_600_000),
    }));

    const sessions = Array.from({ length: SESSIONS }, (_, i) => ({
      _id: i + 1,
      device: ['ios', 'android', 'web'][i % 3],
      ended: i % 4 !== 0,
      duration_ms: 1000 + ((i * 53) % 900_000),
    }));

    for (let i = 0; i < events.length; i += 10_000) {
      await db.collection('events').insertMany(events.slice(i, i + 10_000));
    }
    await db.collection('sessions').insertMany(sessions);

    console.log(`  events   ${EVENTS.toLocaleString()} documents`);
    console.log(`  sessions ${SESSIONS.toLocaleString()} documents`);
    console.log(
      isReplicaSet
        ? '\nSeeded. This deployment is a replica set, so transactions — and therefore previews — will work.'
        : '\nSeeded, but this deployment is NOT a replica set. Multi-document transactions are ' +
            'unavailable, so Dry Run could not roll back a preview here. Use an Atlas cluster.',
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
