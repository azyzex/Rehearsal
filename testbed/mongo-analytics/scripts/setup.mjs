#!/usr/bin/env node
/**
 * Seeds the MongoDB testbed.
 *
 *   node testbed/mongo-analytics/scripts/setup.mjs --url "mongodb://127.0.0.1:54330/analytics?replicaSet=testset"
 *
 * Mongo needs a replica set for multi-document transactions, which is what the
 * rollback mechanism depends on. `npm run testbed:mongo` starts one; Atlas
 * gives you one on the free tier; a plain local `mongod` does not, and the
 * preview will refuse there rather than run something it could not undo.
 *
 * ---
 *
 * This data is deliberately shaped like a document database rather than like a
 * relational one with different words.
 *
 * The first version of this file was two flat collections whose fields were
 * scalars — which is a SQL schema wearing a hat, and it tested nothing that
 * only MongoDB can do. Everything below exists because it is a shape the other
 * two engines cannot hold:
 *
 *   - **Embedded subdocuments**, two and three levels deep. `users.profile`,
 *     `sessions.device`, `orders.shipping.address`. The schema explorer has to
 *     render `profile.display_name` as the thing Mongo addresses it by.
 *   - **Arrays of scalars** — `users.roles`, `accounts.feature_flags`.
 *   - **Arrays of embedded documents** — `orders.items`. This is the pattern
 *     that replaces a join table, and it means a single `$unset` can destroy
 *     data across what SQL would call three tables.
 *   - **Polymorphic fields**: `events.props` and `integrations.config` hold a
 *     genuinely different shape per document. There is no column type that
 *     describes them, and a schema explorer that picks one is lying.
 *   - **A field holding two types.** `orders.total` is a double on newer
 *     documents and an int on older ones, which is ordinary here and
 *     impossible in a column.
 *   - **Missing versus null.** Both mean "no value", and only this database
 *     can tell them apart.
 *
 * And it is messy on purpose, the same way the SQL testbeds are: orphaned
 * references, a field nothing ever filled in, duplicates, and a filter that
 * matches far more than its author expects.
 */

// Overridable, because the full set is a few hundred thousand documents and a
// smaller one is often what you want when you are iterating on the panel.
const ACCOUNTS = Number(argOf('--accounts', 500));
const USERS = Number(argOf('--users', 60_000));
const SESSIONS = Number(argOf('--sessions', 150_000));
const ORDERS = Number(argOf('--orders', 80_000));
const EVENTS = Number(argOf('--events', 400_000));

const BATCH = 10_000;

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function arg(name, fallback) {
  return argOf(name, fallback);
}

async function loadDriver() {
  try {
    return (await import('mongodb')).MongoClient;
  } catch {
    throw new Error('mongodb is not installed:\n  npm install --save-dev mongodb');
  }
}

const PLANS = ['free', 'team', 'business', 'enterprise'];
const DEVICES = ['ios', 'android', 'web', 'desktop'];
const BROWSERS = ['safari', 'chrome', 'firefox', 'edge'];
const COUNTRIES = ['TN', 'FR', 'DE', 'US', 'GB', 'JP', 'BR'];
const PROVIDERS = ['stripe', 'slack', 'github', 'sendgrid', 'segment'];
const EVENT_NAMES = ['view', 'click', 'purchase', 'signup', 'error'];

/** Inserts in batches, because one insertMany of 400,000 is a bad idea. */
async function insertAll(collection, documents) {
  for (let i = 0; i < documents.length; i += BATCH) {
    await collection.insertMany(documents.slice(i, i + BATCH), { ordered: false });
  }
}

function buildAccounts() {
  return Array.from({ length: ACCOUNTS }, (_, i) => {
    const id = i + 1;
    const plan = PLANS[i % PLANS.length];

    return {
      _id: id,
      name: `account-${id}`,
      plan,
      // An embedded subdocument. In SQL this is either five more columns or a
      // second table; here it is one field with a shape.
      billing: {
        currency: i % 7 === 0 ? 'EUR' : 'USD',
        seats: 1 + (i % 40),
        // Missing entirely on free accounts, rather than null. The distinction
        // is the point.
        ...(plan === 'free' ? {} : { card_last4: String(4000 + (i % 6000)).slice(-4) }),
        renewal: {
          interval: i % 3 === 0 ? 'yearly' : 'monthly',
          auto: i % 11 !== 0,
        },
      },
      // An array of scalars.
      feature_flags: ['new-nav', 'beta-search', 'usage-graphs', 'sso'].slice(0, 1 + (i % 4)),
      created_at: new Date(Date.now() - (i % 900) * 86_400_000),
    };
  });
}

function buildIntegrations() {
  // Three or four per account, and every provider stores a different shape.
  // This is the collection that has no relational equivalent at all: `config`
  // is not a type, it is five types wearing one field name.
  const integrations = [];
  let id = 1;

  for (let account = 1; account <= ACCOUNTS; account += 1) {
    for (let n = 0; n < 1 + (account % 4); n += 1) {
      const provider = PROVIDERS[(account + n) % PROVIDERS.length];

      const config =
        provider === 'stripe'
          ? { mode: account % 2 ? 'live' : 'test', webhook: { url: `https://hooks.example/${id}`, events: ['charge.succeeded', 'charge.failed'] } }
          : provider === 'slack'
            ? { workspace: `T${1000 + account}`, channels: ['#alerts', '#general'].slice(0, 1 + (n % 2)) }
            : provider === 'github'
              ? { org: `org-${account}`, repos: [`repo-${account}-a`, `repo-${account}-b`], install_id: 10_000 + id }
              : provider === 'sendgrid'
                ? { from: `no-reply@account-${account}.example`, verified: n % 3 !== 0 }
                : { write_key: `wk_${id}`, sample_rate: 0.1 * (1 + (n % 9)) };

      integrations.push({
        _id: id,
        account_id: account,
        provider,
        enabled: id % 9 !== 0,
        config,
        // Never set by anything. The schemaless equivalent of a column nobody
        // has ever written to, and the case Dry Run should call safe to drop.
        deprecated_scopes: null,
        connected_at: new Date(Date.now() - (id % 400) * 86_400_000),
      });
      id += 1;
    }
  }

  return integrations;
}

function buildUsers() {
  return Array.from({ length: USERS }, (_, i) => {
    const id = i + 1;
    // The last few hundred point at an account that does not exist. Orphans,
    // the same way the SQL testbeds have them.
    const accountId = i >= USERS - 400 ? 99_999 : 1 + (i % ACCOUNTS);

    const user = {
      _id: id,
      account_id: accountId,
      // Twelve percent have no email: half hold null, half are missing the
      // field. Both mean "no value" and only this database can tell them apart.
      ...(i % 100 < 12 ? (i % 2 === 0 ? { email: null } : {}) : { email: `user${id}@example.com` }),
      // A handful share one, which is what makes a unique index interesting.
      ...(i % 5000 === 0 ? { email: 'dupe@example.com' } : {}),
      profile: {
        display_name: `User ${id}`,
        locale: i % 4 === 0 ? 'fr-FR' : 'en-US',
        avatar: i % 6 === 0 ? null : `https://avatars.example/${id}.png`,
        // Three levels deep.
        preferences: {
          theme: i % 3 === 0 ? 'dark' : 'light',
          notifications: {
            email: i % 7 !== 0,
            push: i % 5 === 0,
            digest: i % 4 === 0 ? 'weekly' : 'never',
          },
        },
      },
      roles: i % 50 === 0 ? ['owner', 'admin'] : i % 7 === 0 ? ['admin'] : ['member'],
      created_at: new Date(Date.now() - (i % 720) * 3_600_000),
    };

    return user;
  });
}

function buildSessions() {
  return Array.from({ length: SESSIONS }, (_, i) => {
    const id = i + 1;

    return {
      _id: id,
      user_id: 1 + (i % USERS),
      // Embedded, rather than four more columns.
      device: {
        kind: DEVICES[i % DEVICES.length],
        browser: BROWSERS[i % BROWSERS.length],
        version: `${10 + (i % 8)}.${i % 10}`,
      },
      geo: {
        country: COUNTRIES[i % COUNTRIES.length],
        city: `city-${i % 300}`,
      },
      ended: i % 4 !== 0,
      duration_ms: 1000 + ((i * 53) % 900_000),
      started_at: new Date(Date.now() - (i % 720) * 3_600_000),
    };
  });
}

function buildOrders() {
  return Array.from({ length: ORDERS }, (_, i) => {
    const id = i + 1;
    const itemCount = 1 + (i % 4);

    // An array of embedded documents. In SQL this is order_items, a second
    // table and a join; here it is one field, and one `$unset` on it destroys
    // what SQL would need a cascade to reach.
    const items = Array.from({ length: itemCount }, (_, n) => ({
      sku: `SKU-${(i * 7 + n) % 5000}`,
      title: `Product ${(i * 7 + n) % 5000}`,
      quantity: 1 + ((i + n) % 3),
      unit_cents: 500 + (((i + n) * 137) % 20_000),
    }));

    const cents = items.reduce((sum, item) => sum + item.quantity * item.unit_cents, 0);

    return {
      _id: id,
      user_id: 1 + (i % USERS),
      account_id: 1 + (i % ACCOUNTS),
      status: ['pending', 'paid', 'shipped', 'refunded'][i % 4],
      items,
      // Deliberately two types. Older orders stored an integer number of cents;
      // newer ones store a float of currency units. Ordinary here, impossible
      // in a column, and the sort of thing a schema explorer should show as
      // both rather than picking one.
      total: i % 3 === 0 ? cents : cents / 100,
      shipping: {
        method: i % 5 === 0 ? 'express' : 'standard',
        address: {
          country: COUNTRIES[i % COUNTRIES.length],
          city: `city-${i % 300}`,
          postcode: String(1000 + (i % 9000)),
        },
      },
      placed_at: new Date(Date.now() - (i % 500) * 86_400_000),
    };
  });
}

function buildEvents() {
  return Array.from({ length: EVENTS }, (_, i) => {
    const id = i + 1;
    const name = EVENT_NAMES[i % EVENT_NAMES.length];

    // Polymorphic by event type. There is no single shape here, which is the
    // whole point: a relational schema would need five nullable columns or a
    // JSON blob, and a document database just holds it.
    const props =
      name === 'purchase'
        ? { order_id: 1 + (i % ORDERS), revenue_cents: (i * 37) % 40_000, coupon: i % 9 === 0 ? `SAVE${i % 30}` : null }
        : name === 'click'
          ? { selector: `#btn-${i % 40}`, position: { x: i % 1200, y: i % 800 } }
          : name === 'error'
            ? { code: `E${100 + (i % 40)}`, fatal: i % 11 === 0, stack_depth: i % 30 }
            : name === 'signup'
              ? { referrer: i % 6 === 0 ? 'organic' : `campaign-${i % 25}` }
              : { path: `/page/${i % 200}`, ms: 20 + (i % 900) };

    // A third carry no user_id. Two thirds of *those* hold an explicit null and
    // the rest omit the field entirely — which is the distinction that makes
    // `{ user_id: null }` match far more than its author expects, because in
    // MongoDB that filter matches both.
    const anonymous = i % 3 === 0;
    const missing = i % 9 === 0;

    return {
      _id: id,
      ...(anonymous ? (missing ? {} : { user_id: null }) : { user_id: 1 + (i % USERS) }),
      session_id: 1 + (i % SESSIONS),
      name,
      props,
      // Present on old documents only — the schemaless equivalent of a column
      // someone believes is unused.
      ...(i % 5 === 0 ? { legacy_utm: `utm-${i % 400}` } : {}),
      created_at: new Date(Date.now() - (i % 720) * 3_600_000),
    };
  });
}

async function main() {
  const MongoClient = await loadDriver();

  const url = arg('--url') ?? process.env.MONGO_URL;
  if (!url) {
    throw new Error('Pass --url "mongodb://…" or set MONGO_URL.');
  }

  const client = new MongoClient(url);
  await client.connect();

  try {
    const isReplicaSet = await client
      .db('admin')
      .admin()
      .command({ hello: 1 })
      .then((info) => Boolean(info.setName))
      .catch(() => false);

    const db = client.db(arg('--db', 'analytics'));

    for (const name of ['accounts', 'integrations', 'users', 'sessions', 'orders', 'events']) {
      await db
        .collection(name)
        .drop()
        .catch(() => {});
    }

    const work = [
      ['accounts', buildAccounts()],
      ['integrations', buildIntegrations()],
      ['users', buildUsers()],
      ['sessions', buildSessions()],
      ['orders', buildOrders()],
      ['events', buildEvents()],
    ];

    for (const [name, documents] of work) {
      await insertAll(db.collection(name), documents);
      console.log(`  ${name.padEnd(13)}${documents.length.toLocaleString()} documents`);
    }

    // Indexed where a real deployment would be, and pointedly not indexed on
    // three reference fields — so Schema Health has something true to find
    // rather than a clean bill on a database nobody has ever used.
    await db.collection('users').createIndex({ account_id: 1 });
    await db.collection('sessions').createIndex({ user_id: 1 });
    await db.collection('events').createIndex({ created_at: -1 });
    await db.collection('orders').createIndex({ status: 1, placed_at: -1 });
    // An index nothing reads, which is the other half of the health report.
    await db.collection('events').createIndex({ legacy_utm: 1 });

    console.log(
      isReplicaSet
        ? '\nSeeded. This deployment is a replica set, so transactions — and therefore previews — will work.'
        : '\nSeeded, but this deployment is NOT a replica set. Multi-document transactions are ' +
            'unavailable, so Dry Run could not roll back a preview here. Use a replica set.',
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
