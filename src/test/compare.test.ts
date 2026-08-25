import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { ColumnInfo, SchemaSnapshot } from '../adapters/types';
import { compareSchemas, comparisonReport } from '../analysis/compare';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Drift between two databases.
 *
 * The pure half is tested against hand-built snapshots because the wording is
 * the product — "add this column to staging" is actionable and "these are
 * different" is not. The half at the bottom builds two real schemas in one
 * server and compares them, so the diff is tested against what the adapter
 * really reports rather than against what these tests imagine it reports.
 */

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, type: 'text', nullable: true, isPrimaryKey: false, ...overrides };
}

function snapshot(
  tables: { name: string; columns: ColumnInfo[] }[],
  foreignKeys: SchemaSnapshot['foreignKeys'] = [],
): SchemaSnapshot {
  return {
    schemas: ['public'],
    foreignKeys,
    tables: tables.map((table) => ({
      schema: 'public',
      name: table.name,
      qualified: table.name,
      rows: 0,
      bytes: 0,
      partitioned: false,
      columns: table.columns,
    })),
  };
}

describe('comparing schemas', () => {
  it('finds nothing between two identical snapshots', () => {
    const one = snapshot([{ name: 'users', columns: [column('id'), column('email')] }]);
    const comparison = compareSchemas(one, snapshot([
      { name: 'users', columns: [column('id'), column('email')] },
    ]));

    assert.equal(comparison.identical, true);
    assert.deepEqual(comparison.tables, []);
  });

  it('is not confused by column order', () => {
    // Two databases built by the same migrations in a different order are the
    // same database, and reporting them as different would train people to
    // ignore the report.
    const comparison = compareSchemas(
      snapshot([{ name: 'users', columns: [column('id'), column('email')] }]),
      snapshot([{ name: 'users', columns: [column('email'), column('id')] }]),
    );
    assert.equal(comparison.identical, true);
  });

  it('reports a table one side is missing', () => {
    const comparison = compareSchemas(
      snapshot([{ name: 'users', columns: [column('id')] }, { name: 'audit', columns: [column('id')] }]),
      snapshot([{ name: 'users', columns: [column('id')] }]),
    );

    assert.deepEqual(comparison.tablesOnlyInLeft, ['audit']);
    assert.deepEqual(comparison.tablesOnlyInRight, []);
  });

  it('reports a table one side has extra', () => {
    const comparison = compareSchemas(
      snapshot([{ name: 'users', columns: [column('id')] }]),
      snapshot([{ name: 'users', columns: [column('id')] }, { name: 'scratch', columns: [column('id')] }]),
    );
    assert.deepEqual(comparison.tablesOnlyInRight, ['scratch']);
  });

  it('reports a column one side is missing', () => {
    const comparison = compareSchemas(
      snapshot([{ name: 'users', columns: [column('id'), column('tier')] }]),
      snapshot([{ name: 'users', columns: [column('id')] }]),
    );

    assert.equal(comparison.tables.length, 1);
    assert.deepEqual(comparison.tables[0]!.onlyInLeft, ['tier']);
  });

  it('reports a type that has drifted', () => {
    const comparison = compareSchemas(
      snapshot([{ name: 'users', columns: [column('id', { type: 'integer' })] }]),
      snapshot([{ name: 'users', columns: [column('id', { type: 'bigint' })] }]),
    );

    assert.deepEqual(comparison.tables[0]!.changed, [
      { column: 'id', what: 'type', left: 'integer', right: 'bigint' },
    ]);
  });

  it('spells nullability the way someone would have to type it', () => {
    const comparison = compareSchemas(
      snapshot([{ name: 'users', columns: [column('email', { nullable: false })] }]),
      snapshot([{ name: 'users', columns: [column('email', { nullable: true })] }]),
    );

    assert.deepEqual(comparison.tables[0]!.changed, [
      { column: 'email', what: 'nullability', left: 'NOT NULL', right: 'nullable' },
    ]);
  });

  it('reports a default that differs, including one that is missing', () => {
    const comparison = compareSchemas(
      snapshot([{ name: 'users', columns: [column('tier', { defaultExpression: `'free'` })] }]),
      snapshot([{ name: 'users', columns: [column('tier')] }]),
    );

    assert.deepEqual(comparison.tables[0]!.changed, [
      { column: 'tier', what: 'default', left: `'free'`, right: 'no default' },
    ]);
  });

  it('reports several differences on one column', () => {
    const comparison = compareSchemas(
      snapshot([
        { name: 'users', columns: [column('n', { type: 'integer', nullable: false })] },
      ]),
      snapshot([{ name: 'users', columns: [column('n', { type: 'bigint', nullable: true })] }]),
    );
    assert.equal(comparison.tables[0]!.changed.length, 2);
  });

  it('compares foreign keys by what they do, not what they are called', () => {
    // Constraint names are assigned freely and differ between environments
    // for no interesting reason.
    const key = (name: string) => [
      { name, fromTable: 'orders', fromColumns: ['user_id'], toTable: 'users', toColumns: ['id'] },
    ];

    const comparison = compareSchemas(
      snapshot([{ name: 'orders', columns: [column('user_id')] }], key('orders_user_fkey')),
      snapshot([{ name: 'orders', columns: [column('user_id')] }], key('fk_orders_users')),
    );

    assert.equal(comparison.identical, true, 'same relationship, different name');
  });

  it('reports a foreign key one side is missing', () => {
    const comparison = compareSchemas(
      snapshot(
        [{ name: 'orders', columns: [column('user_id')] }],
        [
          {
            name: 'orders_user_fkey',
            fromTable: 'orders',
            fromColumns: ['user_id'],
            toTable: 'users',
            toColumns: ['id'],
          },
        ],
      ),
      snapshot([{ name: 'orders', columns: [column('user_id')] }]),
    );

    assert.deepEqual(comparison.foreignKeysOnlyInLeft, ['orders (user_id) -> users (id)']);
  });
});

describe('the comparison report', () => {
  const names = { left: 'production', right: 'staging' };

  it('says plainly when they match, and what it did not look at', () => {
    const report = comparisonReport(
      compareSchemas(snapshot([]), snapshot([])),
      names,
      new Date('2026-08-24T12:00:00Z'),
    );
    assert.match(report, /same tables, columns, types, nullability, defaults/);
    assert.match(report, /Indexes, triggers, permissions and data are not/);
  });

  it('phrases the work as what the compared database is missing', () => {
    const report = comparisonReport(
      compareSchemas(
        snapshot([{ name: 'audit', columns: [column('id')] }]),
        snapshot([]),
      ),
      names,
    );
    assert.match(report, /## Tables missing from staging/);
    assert.match(report, /`audit`/);
  });

  it('names both sides in the table of differences', () => {
    const report = comparisonReport(
      compareSchemas(
        snapshot([{ name: 'users', columns: [column('id', { type: 'integer' })] }]),
        snapshot([{ name: 'users', columns: [column('id', { type: 'bigint' })] }]),
      ),
      names,
    );
    assert.match(report, /\| Column \| What \| production \| staging \|/);
    assert.match(report, /\| `id` \| type \| integer \| bigint \|/);
  });

  it('always lists what it did not compare', () => {
    const report = comparisonReport(
      compareSchemas(snapshot([{ name: 'a', columns: [column('id')] }]), snapshot([])),
      names,
    );
    assert.match(report, /Not compared: indexes/);
    assert.match(report, /and the data itself/);
  });
});

describe('against two real schemas', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let db: Client;

  before(async () => {
    fixture = await startPostgres();
    db = new Client({ connectionString: fixture.connectionString });
    await db.connect();

    // Two schemas in one server stand in for two databases: the snapshot is
    // read per schema, and the diff never learns where they came from.
    await db.query(`
      CREATE SCHEMA prod;
      CREATE SCHEMA stage;

      CREATE TABLE prod.users (
        id     serial PRIMARY KEY,
        email  text NOT NULL,
        tier   text DEFAULT 'free',
        secret text
      );

      CREATE TABLE stage.users (
        id    serial PRIMARY KEY,
        email text,
        tier  text
      );

      CREATE TABLE prod.orders (
        id      serial PRIMARY KEY,
        user_id int NOT NULL REFERENCES prod.users (id)
      );

      CREATE TABLE stage.orders (
        id      serial PRIMARY KEY,
        user_id int NOT NULL
      );
    `);

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await db?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  it('finds the drift the adapter really reports', async () => {
    const full = await adapter.schemaSnapshot();
    const only = (schema: string): SchemaSnapshot => ({
      schemas: [schema],
      tables: full.tables
        .filter((table) => table.schema === schema)
        .map((table) => ({ ...table, qualified: table.name })),
      foreignKeys: full.foreignKeys
        .filter((key) => key.fromTable.startsWith(`${schema}.`))
        .map((key) => ({
          ...key,
          fromTable: key.fromTable.replace(`${schema}.`, ''),
          toTable: key.toTable.replace(`${schema}.`, ''),
        })),
    });

    const comparison = compareSchemas(only('prod'), only('stage'));

    const users = comparison.tables.find((table) => table.table === 'users');
    assert.ok(users, 'users differs');
    assert.deepEqual(users!.onlyInLeft, ['secret'], 'staging never got the column');

    assert.ok(
      users!.changed.some(
        (difference) => difference.what === 'nullability' && difference.column === 'email',
      ),
      'the NOT NULL was applied to one and not the other',
    );
    assert.ok(
      users!.changed.some(
        (difference) => difference.what === 'default' && difference.column === 'tier',
      ),
      "and so was the default — read from the catalogue, not from anything this test wrote",
    );

    assert.deepEqual(comparison.foreignKeysOnlyInLeft, ['orders (user_id) -> users (id)']);
  });
});
