import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { SchemaSnapshot } from '../adapters/types';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The schema snapshot behind the explorer.
 *
 * The explorer draws whatever this returns, so the interesting properties are
 * about completeness and about what is deliberately left out: nobody opening a
 * diagram of their application wants `pg_catalog` in it.
 */

describe('schemaSnapshot', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;
  let snapshot: SchemaSnapshot;

  before(async () => {
    fixture = await startPostgres();
    verifier = new Client({ connectionString: fixture.connectionString });
    await verifier.connect();

    // A second schema and a real relationship, so the snapshot has something
    // with shape to report.
    await verifier.query(`
      ALTER TABLE users ADD CONSTRAINT users_org_fkey
        FOREIGN KEY (org_id) REFERENCES orgs (id) NOT VALID;
      CREATE SCHEMA billing;
      CREATE TABLE billing.invoices (
        id        serial PRIMARY KEY,
        user_id   integer NOT NULL REFERENCES users (id),
        amount    integer NOT NULL,
        issued_at timestamptz
      );
      ANALYZE;
    `);

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });

    snapshot = await adapter.schemaSnapshot();
  });

  after(async () => {
    await verifier?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  it('finds every user table', () => {
    const names = snapshot.tables.map((t) => t.qualified).sort();
    assert.deepEqual(names, ['billing.invoices', 'orgs', 'users']);
  });

  it('leaves the system catalog out of it', () => {
    assert.equal(
      snapshot.tables.some((t) => t.schema === 'pg_catalog' || t.schema === 'information_schema'),
      false,
    );
  });

  it('qualifies names only when they are not in public', () => {
    assert.equal(snapshot.tables.find((t) => t.name === 'users')!.qualified, 'users');
    assert.equal(snapshot.tables.find((t) => t.name === 'invoices')!.qualified, 'billing.invoices');
  });

  it('carries the columns of every table, in declaration order', () => {
    const users = snapshot.tables.find((t) => t.qualified === 'users')!;
    assert.deepEqual(
      users.columns.map((c) => c.name),
      ['id', 'email', 'tier', 'phone_number', 'nickname', 'org_id'],
    );

    const id = users.columns[0]!;
    assert.equal(id.isPrimaryKey, true);
    assert.equal(id.nullable, false);

    const email = users.columns[1]!;
    assert.equal(email.isPrimaryKey, false);
    assert.equal(email.nullable, true);
    assert.equal(email.type, 'text');
  });

  it('carries row counts and sizes for the cards', () => {
    const users = snapshot.tables.find((t) => t.qualified === 'users')!;
    assert.equal(users.rows, 100);
    assert.ok(users.bytes > 0);
  });

  it('finds relationships, including across schemas', () => {
    const withinPublic = snapshot.foreignKeys.find((fk) => fk.name === 'users_org_fkey')!;
    assert.equal(withinPublic.fromTable, 'users');
    assert.deepEqual(withinPublic.fromColumns, ['org_id']);
    assert.equal(withinPublic.toTable, 'orgs');
    assert.deepEqual(withinPublic.toColumns, ['id']);

    const crossSchema = snapshot.foreignKeys.find((fk) => fk.fromTable === 'billing.invoices')!;
    assert.equal(crossSchema.toTable, 'users', 'an edge that leaves its own schema still resolves');
  });

  it('reports the schemas it found, public first', () => {
    assert.deepEqual(snapshot.schemas, ['public', 'billing']);
  });

  it('reads the whole schema without opening a transaction', async () => {
    // The explorer is a reader. If it ever needed a transaction, it would be
    // taking locks on a database someone is using.
    const before = await inTransaction();
    await adapter.schemaSnapshot();
    assert.equal(await inTransaction(), before);
  });

  const inTransaction = async (): Promise<number> => {
    const { rows } = await verifier.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE application_name = $1 AND state = 'idle in transaction'`,
      [APPLICATION_NAME],
    );
    return Number(rows[0].n);
  };
});
