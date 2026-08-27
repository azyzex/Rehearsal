import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { downMigration } from '../edit/down';
import { describeVerification, verifyDownMigration } from '../edit/verifyDown';
import { Changeset } from '../edit/changeset';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The down migration, proved by running it.
 *
 * Every migration tool asks for one; almost nobody runs one until the night it
 * matters. What is checked here is both halves of the claim — that a correct
 * reversal is confirmed, and that an incorrect one is caught with the actual
 * difference named. The second is the one that earns the feature, so the tests
 * for it hand the verifier a reversal that is subtly wrong rather than one that
 * is obviously broken.
 */

describe('verifying a down migration by running it', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;

  before(async () => {
    fixture = await startPostgres();

    const client = new Client({ connectionString: fixture.connectionString });
    await client.connect();
    // Its own table: the shared fixture already seeds `users`, and a test that
    // reshapes a table other tests read would fail somewhere else.
    await client.query(`
      CREATE TABLE accounts (
        id     serial PRIMARY KEY,
        email  text NOT NULL,
        status text DEFAULT 'active',
        tier   text
      )
    `);
    await client.query(
      "INSERT INTO accounts (email) SELECT 'u' || i FROM generate_series(1, 20) i",
    );
    await client.end();

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 5000,
      applicationName: 'vscode-dryrun',
    });
  });

  after(async () => {
    await adapter.dispose().catch(() => undefined);
    await fixture.stop();
  });

  /** The statements a changeset would run, in the shape the verifier takes. */
  function up(edits: Parameters<Changeset['add']>[0][]): { sql: string }[] {
    const changeset = new Changeset();
    for (const edit of edits) {
      changeset.add(edit);
    }
    return changeset.statements().map((statement) => ({ sql: statement.sql }));
  }

  it('confirms a reversal that really does restore the schema', async () => {
    const edits = [
      { kind: 'add_column' as const, table: 'accounts', column: 'phone', type: 'text', nullable: true },
    ];
    const down = await downMigration(adapter, edits);
    const result = await verifyDownMigration(adapter, up(edits), down);

    assert.equal(result.ran, true, result.skipped);
    assert.equal(result.restored, true, result.differences.join(' '));
    assert.deepEqual(result.differences, []);
    assert.match(describeVerification(result).join(' '), /came back exactly as it was/);
  });

  /**
   * The bug this exists to find.
   *
   * Putting the column back is the obvious half and the easy half. Putting it
   * back with its default is the half that gets forgotten, and a schema missing
   * a default looks identical in every diff until a row is inserted without one.
   */
  it('catches a reversal that forgets the default', async () => {
    const down = {
      statements: ['ALTER TABLE accounts ADD COLUMN status text'],
      gaps: [],
      sql: '',
    };

    const result = await verifyDownMigration(
      adapter,
      [{ sql: 'ALTER TABLE accounts DROP COLUMN status' }],
      down,
    );

    assert.equal(result.ran, true, result.skipped);
    assert.equal(result.restored, false, 'a missing default was reported as restored');
    assert.equal(result.differences.length, 1, result.differences.join(' '));
    assert.match(result.differences[0]!, /accounts\.status/);
    assert.match(result.differences[0]!, /without its default/);
  });

  it('catches an index the reversal leaves behind', async () => {
    const result = await verifyDownMigration(
      adapter,
      [{ sql: 'CREATE INDEX accounts_tier_idx ON accounts (tier)' }],
      { statements: ['SELECT 1'], gaps: [], sql: '' },
    );

    assert.equal(result.restored, false);
    assert.match(result.differences.join(' '), /accounts_tier_idx is still there/);
  });

  it('catches a column the reversal does not drop', async () => {
    const result = await verifyDownMigration(
      adapter,
      [{ sql: 'ALTER TABLE accounts ADD COLUMN nickname text' }],
      { statements: ['SELECT 1'], gaps: [], sql: '' },
    );

    assert.equal(result.restored, false);
    assert.match(result.differences.join(' '), /accounts\.nickname is still there/);
  });

  /**
   * The worst kind of down migration: the one that does not run at all. It is
   * also the one discovered at two in the morning, which is why it gets its own
   * headline rather than being folded in with the differences.
   */
  it('reports a reversal the server refuses, with what it said', async () => {
    const result = await verifyDownMigration(
      adapter,
      [{ sql: 'ALTER TABLE accounts ADD COLUMN nickname text' }],
      { statements: ['ALTER TABLE accounts DROP COLUMN no_such_column'], gaps: [], sql: '' },
    );

    assert.equal(result.ran, true);
    assert.equal(result.restored, false);
    assert.match(String(result.failed?.error), /no_such_column/);
    assert.match(describeVerification(result).join(' '), /DOES NOT RUN/);
  });

  it('does not blame the reversal for a change that would not apply', async () => {
    const result = await verifyDownMigration(
      adapter,
      [{ sql: 'ALTER TABLE accounts ADD COLUMN email text' }],
      { statements: ['ALTER TABLE accounts DROP COLUMN email'], gaps: [], sql: '' },
    );

    assert.equal(result.ran, false);
    assert.match(String(result.skipped), /change itself did not apply/);
  });

  it('leaves the database exactly as it found it', async () => {
    // Everything above applied a schema change and its reversal. None of it
    // was committed, which is the property the whole project rests on.
    const columns = await adapter.tableColumns('accounts');
    assert.deepEqual(
      columns.map((column) => column.name),
      ['id', 'email', 'status', 'tier'],
    );
    assert.equal(await adapter.countRows('accounts'), 20);
  });
});
