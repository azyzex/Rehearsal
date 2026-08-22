#!/usr/bin/env node
/**
 * Seeds the Postgres testbed.
 *
 *   node testbed/postgres-shop/scripts/setup.mjs --url "postgresql://..."
 *   node testbed/postgres-shop/scripts/setup.mjs            # reads DATABASE_URL
 *
 * Options:
 *   --url <string>     connection string (else DATABASE_URL, else testbed .env)
 *   --users <n>        how many users to create        (default 50000)
 *   --orders <n>       how many orders to create       (default 300000)
 *
 * This script DROPS AND RECREATES all twenty-one tables, so it refuses to run against
 * anything whose host or database name looks like production — the same rule
 * the extension itself applies.
 *
 * Everything is seeded with server-side `generate_series`, so the whole thing is
 * a handful of round trips and stays fast against a remote database.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');

const PRODUCTION_PATTERNS = [/prod/i, /production/i, /live/i];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function resolveUrl() {
  const explicit = arg('--url') ?? process.env.DATABASE_URL;
  if (explicit) return explicit;

  try {
    const env = await readFile(join(PROJECT, '.env'), 'utf8');
    const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+)$/m.exec(env);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* no .env, fall through to the error below */
  }

  throw new Error(
    'No connection string. Pass --url "postgresql://…", set DATABASE_URL, or create ' +
      'testbed/postgres-shop/.env from .env.example.',
  );
}

/** Host and database only — the password is never inspected or printed. */
function identify(url) {
  try {
    const parsed = new URL(url);
    return {
      display: `${parsed.hostname}:${parsed.port || '5432'}/${parsed.pathname.replace(/^\//, '')}`,
    };
  } catch {
    return { display: '(unparseable connection string)' };
  }
}

function refuseProduction(url) {
  const { display } = identify(url);
  const matched = PRODUCTION_PATTERNS.find((p) => p.test(display));
  if (matched) {
    throw new Error(
      `Refusing to seed ${display}: it matches ${matched}. This script drops tables. ` +
        `Point it at a scratch database.`,
    );
  }
  return display;
}

const USERS = Number(arg('--users', '50000'));
const ORDERS = Number(arg('--orders', '300000'));
// Scaled off the user count, so `--users 2000` shrinks the whole thing rather
// than leaving a small users table joined to a huge one.
const scaled = (fraction, minimum) => Math.max(minimum, Math.round(USERS * fraction));
const PRODUCTS = scaled(0.1, 200);
const REVIEWS = scaled(0.4, 500);
const MOVEMENTS = scaled(1, 2000);
const ORPHAN_USERS = 200; // users pointing at an org that does not exist
const ORPHAN_ORDERS = 150; // orders pointing at a user that does not exist
const NULL_EMAILS = 12;
const DUPLICATE_EMAILS = 40;

async function main() {
  const url = await resolveUrl();
  const display = refuseProduction(url);

  console.log(`Seeding ${display}`);
  console.log(`  users: ${USERS.toLocaleString()}   orders: ${ORDERS.toLocaleString()}\n`);

  const client = new pg.Client({
    connectionString: url,
    application_name: 'dryrun-testbed-setup',
    statement_timeout: 120_000,
  });
  await client.connect();

  try {
    const schema = await readFile(join(PROJECT, 'sql', 'schema.sql'), 'utf8');
    await step(client, 'schema', schema);

    await step(
      client,
      'orgs',
      `INSERT INTO orgs (name, plan)
       SELECT 'org-' || i, CASE WHEN i <= 2 THEN 'enterprise' ELSE 'standard' END
         FROM generate_series(1, 8) AS i`,
    );

    await step(
      client,
      'users',
      `INSERT INTO users (email, tier, phone_number, nickname, org_id, signup_source, created_at)
       SELECT
         CASE
           WHEN i <= $2 THEN NULL
           WHEN i <= $2 + $3 THEN 'shared@example.com'
           ELSE 'user' || i || '@example.com'
         END,
         CASE WHEN i % 17 = 0 THEN 'enterprise' WHEN i % 3 = 0 THEN 'pro' ELSE 'free' END,
         -- Irregular on purpose: a round 80% would look synthetic in a demo.
         CASE WHEN i % 5 <> 0 OR i % 137 = 0 THEN '+1555' || lpad(i::text, 7, '0') END,
         NULL,
         CASE WHEN i > $1 - $4 THEN 999 ELSE 1 + (i % 8) END,
         CASE WHEN i % 4 = 0 THEN 'ios' WHEN i % 7 = 0 THEN 'android' ELSE 'web' END,
         now() - (i % 900) * interval '1 day'
       FROM generate_series(1, $1) AS i`,
      [USERS, NULL_EMAILS, DUPLICATE_EMAILS, ORPHAN_USERS],
    );

    await step(
      client,
      'orders',
      `INSERT INTO orders (user_id, status, total_cents, placed_at)
       SELECT
         CASE WHEN i <= $3 THEN $2 + 100000 ELSE 1 + (i % $2) END,
         CASE WHEN i % 11 = 0 THEN 'refunded' WHEN i % 5 = 0 THEN 'pending' ELSE 'paid' END,
         -- Refunds were historically written as zero, which is why a
         -- CHECK (total_cents > 0) added later has violations to find.
         CASE WHEN i % 11 = 0 THEN 0 ELSE 500 + (i * 37) % 45000 END,
         now() - (i % 720) * interval '1 hour'
       FROM generate_series(1, $1) AS i`,
      [ORDERS, USERS, ORPHAN_ORDERS],
    );

    await step(
      client,
      'carts',
      `INSERT INTO carts (user_id, item_count, abandoned, updated_at)
       SELECT 1 + (i % $1), 1 + (i % 6), i % 3 <> 0, now() - (i % 240) * interval '1 hour'
         FROM generate_series(1, 5000) AS i`,
      [USERS],
    );

    // ---- the related tables, in dependency order --------------------------

    await step(
      client,
      'countries',
      `INSERT INTO countries (code, name)
       SELECT chr(65 + (i / 26) % 26) || chr(65 + i % 26), 'Country ' || i
         FROM generate_series(1, 24) AS i`,
    );

    await step(
      client,
      'warehouses',
      `INSERT INTO warehouses (country_id, name, capacity)
       SELECT 1 + (i % 24), 'Warehouse ' || i, 5000 + i * 250
         FROM generate_series(1, 8) AS i`,
    );

    await step(
      client,
      'suppliers',
      `INSERT INTO suppliers (country_id, name, contact_email)
       SELECT 1 + (i % 24), 'Supplier ' || i,
              CASE WHEN i % 7 <> 0 THEN 'supplier' || i || '@example.com' END
         FROM generate_series(1, 40) AS i`,
    );

    // Top-level categories first, then children pointing at them, so the
    // self-reference always resolves.
    await step(
      client,
      'categories',
      `INSERT INTO categories (parent_id, name, slug)
       SELECT NULL, 'Category ' || i, 'category-' || i FROM generate_series(1, 8) AS i;
       INSERT INTO categories (parent_id, name, slug)
       SELECT 1 + (i % 8), 'Subcategory ' || i, 'subcategory-' || i
         FROM generate_series(1, 24) AS i`,
    );

    await step(
      client,
      'products',
      `INSERT INTO products (category_id, supplier_id, sku, name, price_cents, discontinued)
       SELECT 1 + (i % 32),
              CASE WHEN i % 13 <> 0 THEN 1 + (i % 40) END,
              'SKU-' || lpad(i::text, 7, '0'),
              'Product ' || i,
              300 + (i * 71) % 60000,
              i % 23 = 0
         FROM generate_series(1, $1) AS i`,
      [PRODUCTS],
    );

    await step(
      client,
      'coupons',
      `INSERT INTO coupons (code, discount_pct, expires_at)
       SELECT 'SAVE' || lpad(i::text, 4, '0'), 5 + (i % 6) * 5,
              now() + (i % 120) * interval '1 day'
         FROM generate_series(1, 200) AS i`,
    );

    await step(
      client,
      'addresses',
      `INSERT INTO addresses (user_id, country_id, line1, city, postcode)
       SELECT 1 + (i % $1), 1 + (i % 24), i || ' Example Street', 'City ' || (i % 400),
              CASE WHEN i % 9 <> 0 THEN lpad(((i * 7) % 99999)::text, 5, '0') END
         FROM generate_series(1, $2) AS i`,
      [USERS, Math.max(1, Math.floor(USERS * 0.6))],
    );

    await step(
      client,
      'sessions',
      `INSERT INTO sessions (user_id, token, expires_at, user_agent)
       SELECT 1 + (i % $1), md5(i::text || 'session'), now() + (i % 30) * interval '1 day',
              CASE WHEN i % 3 = 0 THEN 'ios' WHEN i % 3 = 1 THEN 'android' ELSE 'web' END
         FROM generate_series(1, $2) AS i`,
      [USERS, Math.max(1, Math.floor(USERS * 0.5))],
    );

    await step(
      client,
      'wishlists',
      `INSERT INTO wishlists (user_id, name)
       SELECT 1 + (i % $1), CASE WHEN i % 4 = 0 THEN 'Gifts' ELSE 'Saved' END
         FROM generate_series(1, $2) AS i`,
      [USERS, Math.max(1, Math.floor(USERS * 0.15))],
    );

    await step(
      client,
      'wishlist_items',
      // Product ids run 1..PRODUCTS contiguously, so the id can be computed
      // directly rather than looked up.
      `INSERT INTO wishlist_items (wishlist_id, product_id)
       SELECT w.id, 1 + ((w.id * 7 + g) % $1)
         FROM wishlists w, generate_series(0, 2) AS g
       ON CONFLICT DO NOTHING`,
      [PRODUCTS],
    );

    await step(
      client,
      'order_items',
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
       SELECT o.id, 1 + ((o.id * 13 + g) % $1), 1 + (o.id + g) % 4, 300 + ((o.id * 71) % 60000)
         FROM orders o, generate_series(0, 1) AS g`,
      [PRODUCTS],
    );

    await step(
      client,
      'payments',
      `INSERT INTO payments (order_id, method, amount_cents, status, captured_at)
       SELECT o.id,
              CASE WHEN o.id % 4 = 0 THEN 'paypal' WHEN o.id % 7 = 0 THEN 'transfer' ELSE 'card' END,
              o.total_cents,
              CASE WHEN o.status = 'refunded' THEN 'refunded'
                   WHEN o.status = 'pending' THEN 'authorised' ELSE 'captured' END,
              CASE WHEN o.status <> 'pending' THEN o.placed_at + interval '2 minutes' END
         FROM orders o`,
    );

    await step(
      client,
      'shipments',
      `INSERT INTO shipments (order_id, address_id, carrier, tracking, shipped_at)
       SELECT o.id,
              1 + (o.id % (SELECT GREATEST(COUNT(*), 1) FROM addresses)),
              CASE WHEN o.id % 3 = 0 THEN 'ups' WHEN o.id % 3 = 1 THEN 'dhl' ELSE 'royalmail' END,
              CASE WHEN o.id % 11 <> 0 THEN 'TRK' || lpad(o.id::text, 10, '0') END,
              CASE WHEN o.id % 11 <> 0 THEN o.placed_at + interval '1 day' END
         FROM orders o
        WHERE o.status <> 'pending'`,
    );

    await step(
      client,
      'order_coupons',
      `INSERT INTO order_coupons (order_id, coupon_id)
       SELECT o.id, 1 + (o.id % 200) FROM orders o WHERE o.id % 9 = 0
       ON CONFLICT DO NOTHING`,
    );

    await step(
      client,
      'reviews',
      `INSERT INTO reviews (product_id, user_id, rating, body)
       SELECT 1 + (i % $1), 1 + (i % $2), 1 + (i % 5),
              CASE WHEN i % 3 <> 0 THEN 'Review body ' || i END
         FROM generate_series(1, $3) AS i`,
      [PRODUCTS, USERS, REVIEWS],
    );

    await step(
      client,
      'cart_items',
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       SELECT c.id, 1 + ((c.id * 5 + g) % $1), 1 + (c.id + g) % 3
         FROM carts c, generate_series(0, 2) AS g`,
      [PRODUCTS],
    );

    await step(
      client,
      'inventory',
      `INSERT INTO inventory_movements (product_id, warehouse_id, delta, reason)
       SELECT 1 + (i % $1), 1 + (i % 8),
              CASE WHEN i % 3 = 0 THEN -(1 + i % 9) ELSE 1 + i % 40 END,
              CASE WHEN i % 3 = 0 THEN 'sale' WHEN i % 5 = 0 THEN 'return' ELSE 'restock' END
         FROM generate_series(1, $2) AS i`,
      [PRODUCTS, MOVEMENTS],
    );

    // Without this, pg_class.reltuples is -1 on a freshly loaded table and every
    // table-size estimate the extension makes would be meaningless.
    await step(client, 'analyze', 'ANALYZE');

    await report(client);
  } finally {
    await client.end();
  }
}

async function step(client, label, sql, params) {
  const started = Date.now();
  process.stdout.write(`  ${label.padEnd(8)} … `);
  const result = await client.query(sql, params);
  const rows = Array.isArray(result) ? null : result.rowCount;
  const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  console.log(rows === null || rows === 0 ? `done (${took})` : `${rows.toLocaleString()} rows (${took})`);
}

/**
 * Measures what was actually seeded and prints what each migration file in this
 * project should therefore report. This doubles as the M2 acceptance check:
 * the panel has to show these numbers.
 */
async function report(client) {
  const one = async (sql) => Number((await client.query(sql)).rows[0].n);

  const phones = await one(`SELECT COUNT(*)::int AS n FROM users WHERE phone_number IS NOT NULL`);
  const nullEmails = await one(`SELECT COUNT(*)::int AS n FROM users WHERE email IS NULL`);
  const nicknames = await one(`SELECT COUNT(*)::int AS n FROM users WHERE nickname IS NOT NULL`);
  const orderCount = await one(`SELECT COUNT(*)::int AS n FROM orders`);
  const freeUsers = await one(`SELECT COUNT(*)::int AS n FROM users WHERE tier = 'free'`);
  const orphanUsers = await one(
    `SELECT COUNT(*)::int AS n FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.org_id IS NOT NULL AND o.id IS NULL`,
  );
  const orphanOrders = await one(
    `SELECT COUNT(*)::int AS n FROM orders x LEFT JOIN users u ON u.id = x.user_id WHERE u.id IS NULL`,
  );
  const dupeRows = await one(
    `SELECT COALESCE(SUM(c), 0)::int AS n FROM (
       SELECT COUNT(*) AS c FROM users WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1
     ) d`,
  );
  const abandoned = await one(`SELECT COUNT(*)::int AS n FROM carts WHERE abandoned`);
  const carts = await one(`SELECT COUNT(*)::int AS n FROM carts`);
  const userCount = await one(`SELECT COUNT(*)::int AS n FROM users`);
  const zeroTotals = await one(`SELECT COUNT(*)::int AS n FROM orders WHERE NOT (total_cents > 0)`);

  const n = (v) => v.toLocaleString();

  // Severities are derived from the same default thresholds the extension
  // uses, not hardcoded. At a small --users the numbers fall below those
  // thresholds and the honest answer changes — and since this printout is the
  // acceptance check for the panel, it has to stay true at any scale.
  const CAUTION_ROWS = 100;
  const DESTRUCTIVE_ROWS = 1000;
  const LARGE_TABLE = 100_000;

  const blastRadius = (rows) =>
    rows === 0 ? 'safe' : rows > DESTRUCTIVE_ROWS ? 'destructive' : rows > CAUTION_ROWS ? 'caution' : 'safe';

  console.log(`\nSeeded. What the panel should say when you preview each file:\n`);
  const rows = [
    ['0001_add_last_seen.sql', 'safe', 'nullable ADD COLUMN, no data touched'],
    ['0002_drop_phone_number.sql', 'destructive', `${n(phones)} rows have a phone number`],
    ['0003_email_not_null.sql', 'blocking', `${n(nullEmails)} rows have no email`],
    [
      '0004_index_orders.sql',
      orderCount > LARGE_TABLE ? 'blocking' : 'caution',
      `${n(orderCount)} rows, no CONCURRENTLY`,
    ],
    ['0005_retire_free_tier.sql', blastRadius(freeUsers), `${n(freeUsers)} rows change tier`],
    ['0006_add_constraints.sql', 'blocking', `${n(orphanUsers)} orphan users, ${n(orphanOrders)} orphan orders, ${n(dupeRows)} duplicate emails, ${n(zeroTotals)} zero-total orders`],
    ['0007_update.sql', 'mixed', 'the four-row demo: red, red, amber, green'],
    ['0008_cleanup_carts.sql', blastRadius(carts), `${n(carts)} carts total, ${n(abandoned)} abandoned`],
    ['0009_safe_changes.sql', 'safe', `nickname is null in all ${n(userCount)} rows (${nicknames} non-null) — DROP COLUMN is safe`],
  ];

  const width = Math.max(...rows.map(([f]) => f.length));
  for (const [file, severity, detail] of rows) {
    console.log(`  ${file.padEnd(width)}  ${severity.padEnd(12)} ${detail}`);
  }

  console.log(
    `\nNext: point the extension at this database and run "Dry Run: Preview" on ` +
      `testbed/postgres-shop/migrations/0007_update.sql`,
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
