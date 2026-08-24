import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { APPLICATION_NAME } from '../constants';
import { ApplyRefusedError, applyChangeset, previewTokenFor } from '../edit/apply';
import { Changeset } from '../edit/changeset';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The write path.
 *
 * Everything else in this suite proves Dry Run cannot change your data. This
 * file proves the one exception behaves: it commits when it should, refuses
 * when it should, and leaves nothing half-applied when a statement fails.
 */

describe('applying a changeset', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
    verifier = new Client({ connectionString: fixture.connectionString });
    await verifier.connect();
  });

  after(async () => {
    await verifier?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  const apply = (changeset: Changeset, overrides: Record<string, unknown> = {}) => {
    const statements = changeset.statements();
    return applyChangeset(adapter, {
      statements,
      previewToken: previewTokenFor(statements),
      confirmedDestructive: false,
      isDestructive: false,
      ...overrides,
    });
  };

  const columnExists = async (column: string): Promise<boolean> => {
    const { rows } = await verifier.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = $1`,
      [column],
    );
    return Number(rows[0].n) > 0;
  };

  it('really commits, unlike every other path in the codebase', async () => {
    const changeset = new Changeset();
    changeset.add({
      kind: 'add_column',
      table: 'users',
      column: 'applied_marker',
      type: 'text',
      nullable: true,
    });

    const result = await apply(changeset);

    assert.equal(result.applied, 1);
    assert.equal(await columnExists('applied_marker'), true, 'visible on another connection');
  });

  it('commits row edits with their bound values', async () => {
    const changeset = new Changeset();
    changeset.add({
      kind: 'update_row',
      table: 'users',
      key: { id: 1 },
      set: { tier: 'applied-tier' },
    });

    const result = await apply(changeset);
    assert.deepEqual(result.rowCounts, [1]);

    const { rows } = await verifier.query(`SELECT tier FROM users WHERE id = 1`);
    assert.equal(rows[0].tier, 'applied-tier');
  });

  it('refuses statements that were never previewed', async () => {
    const changeset = new Changeset();
    changeset.add({ kind: 'drop_column', table: 'users', column: 'nickname' });

    await assert.rejects(
      apply(changeset, { previewToken: 'not-a-real-token' }),
      ApplyRefusedError,
    );
    assert.equal(await columnExists('nickname'), true, 'nothing happened');
  });

  it('refuses a changeset edited after it was previewed', async () => {
    // The mistake this exists to prevent: preview, add one more edit, apply.
    // The extra edit would otherwise run having never been measured.
    const changeset = new Changeset();
    changeset.add({
      kind: 'add_column',
      table: 'users',
      column: 'previewed',
      type: 'text',
      nullable: true,
    });
    const staleToken = previewTokenFor(changeset.statements());

    changeset.add({ kind: 'drop_column', table: 'users', column: 'nickname' });

    await assert.rejects(
      apply(changeset, { previewToken: staleToken }),
      /have changed since they were/,
    );
    assert.equal(await columnExists('nickname'), true);
    assert.equal(await columnExists('previewed'), false, 'not even the previewed part ran');
  });

  it('refuses a destructive changeset that was not explicitly confirmed', async () => {
    const changeset = new Changeset();
    changeset.add({ kind: 'drop_column', table: 'users', column: 'nickname' });

    await assert.rejects(
      apply(changeset, { isDestructive: true, confirmedDestructive: false }),
      /explicit confirmation/,
    );
    assert.equal(await columnExists('nickname'), true);
  });

  it('applies a destructive changeset once it is confirmed', async () => {
    const changeset = new Changeset();
    changeset.add({ kind: 'drop_column', table: 'users', column: 'nickname' });

    await apply(changeset, { isDestructive: true, confirmedDestructive: true });
    assert.equal(await columnExists('nickname'), false);
  });

  it('applies the whole set or none of it', async () => {
    // The second statement fails. The first must not survive: a half-applied
    // changeset is exactly the failure this extension exists to warn about.
    const changeset = new Changeset();
    changeset.add({
      kind: 'add_column',
      table: 'users',
      column: 'first_of_two',
      type: 'text',
      nullable: true,
    });
    changeset.add({ kind: 'drop_column', table: 'users', column: 'column_that_is_not_there' });

    await assert.rejects(apply(changeset));
    assert.equal(await columnExists('first_of_two'), false, 'the successful half was rolled back');
  });

  it('refuses an empty changeset rather than opening a transaction for nothing', async () => {
    await assert.rejects(apply(new Changeset()), /nothing to apply/);
  });

  it('leaves the connection usable after a failure', async () => {
    const stillWorks = await adapter.withRollback(async (tx) => {
      const { rows } = await tx.query('SELECT 1 AS ok');
      return Number(rows[0]!['ok']);
    });
    assert.equal(stillWorks, 1);
  });
});

describe('previewTokenFor', () => {
  it('changes when the statements change', () => {
    const one = new Changeset();
    one.add({ kind: 'drop_column', table: 'users', column: 'a' });

    const two = new Changeset();
    two.add({ kind: 'drop_column', table: 'users', column: 'b' });

    assert.notEqual(previewTokenFor(one.statements()), previewTokenFor(two.statements()));
  });

  it('changes when only a bound value changes', () => {
    // The SQL is identical here; only the parameter differs. A token over the
    // SQL alone would let a different row be edited than the one previewed.
    const one = new Changeset();
    one.add({ kind: 'delete_row', table: 'users', key: { id: 1 } });

    const two = new Changeset();
    two.add({ kind: 'delete_row', table: 'users', key: { id: 2 } });

    assert.equal(one.statements()[0]!.sql, two.statements()[0]!.sql, 'same SQL');
    assert.notEqual(previewTokenFor(one.statements()), previewTokenFor(two.statements()));
  });

  it('is stable for the same statements', () => {
    const changeset = new Changeset();
    changeset.add({ kind: 'drop_column', table: 'users', column: 'a' });
    assert.equal(previewTokenFor(changeset.statements()), previewTokenFor(changeset.statements()));
  });
});
