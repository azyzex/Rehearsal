import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { DEFAULT_THRESHOLDS } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { EditSession } from '../edit/session';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The visual editor end to end: edit, preview, apply.
 *
 * The property that matters is that the visual path gets no shortcut. A change
 * made by clicking goes through exactly the same preview as a hand-written
 * migration file — really executed, measured, rolled back — and only then can
 * be applied.
 */

describe('edit session', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;
  let session: EditSession;

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

  const freshSession = async (): Promise<EditSession> => {
    const next = new EditSession();
    next.setBaseline(await adapter.schemaSnapshot());
    return next;
  };

  const preview = (s: EditSession) => s.preview(adapter, DEFAULT_THRESHOLDS);

  it('measures a visual drop against the real data', async () => {
    session = await freshSession();
    session.add({ kind: 'drop_column', table: 'users', column: 'phone_number' });

    const result = await preview(session);

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.severity, 'destructive');
    assert.equal(result.findings[0]!.rowCount, 50);
    assert.match(result.findings[0]!.detail, /50 rows have a value in phone_number/);
    assert.equal(result.destructive, true);
    assert.match(result.summary, /1 would destroy data/);
  });

  it('calls a visual drop of an empty column safe', async () => {
    // The case that makes the red ones believable.
    session = await freshSession();
    session.add({ kind: 'drop_column', table: 'users', column: 'nickname' });

    const result = await preview(session);
    assert.equal(result.findings[0]!.severity, 'safe');
    assert.equal(result.destructive, false);
  });

  it('measures a visual row edit, with a real before and after', async () => {
    session = await freshSession();
    session.add({
      kind: 'update_row',
      table: 'users',
      key: { id: 3 },
      set: { tier: 'visually-edited' },
    });

    const result = await preview(session);
    const finding = result.findings[0]!;

    assert.equal(finding.rowCount, 1, 'exactly the row that was clicked');

    const sampled = finding.sample!.rows[0]!;
    assert.equal(sampled.after!['tier'], 'visually-edited');
    assert.notEqual(sampled.before!['tier'], 'visually-edited');
    assert.deepEqual(sampled.changed, ['tier']);

    const { rows } = await verifier.query(`SELECT tier FROM users WHERE id = 3`);
    assert.notEqual(rows[0].tier, 'visually-edited', 'previewing changed nothing');
  });

  it('reports the projection alongside the measurement', async () => {
    session = await freshSession();
    session.add({ kind: 'drop_column', table: 'users', column: 'phone_number' });
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'phone',
      type: 'text',
      nullable: true,
    });

    const state = session.state();

    // The projection answers "what will it look like"; the preview answers
    // "what will it cost". Both, separately.
    const users = state.projected.tables.find((t) => t.qualified === 'users')!;
    assert.equal(users.columns.some((c) => c.name === 'phone_number'), false);
    assert.equal(users.columns.some((c) => c.name === 'phone'), true);

    assert.equal(state.changes.length, 2);
    assert.match(state.changes[0]!.label, /Drop users.phone_number/);
    assert.match(state.sql, /ALTER TABLE "users" DROP COLUMN "phone_number";/);
  });

  it('catches a change that projects cleanly but fails in reality', async () => {
    // The whole reason the projection is not enough on its own: this looks
    // perfectly fine as a picture and cannot actually run.
    session = await freshSession();
    session.add({
      kind: 'set_nullability',
      table: 'users',
      column: 'email',
      nullable: false,
    });

    const state = session.state();
    const projectedEmail = state.projected.tables
      .find((t) => t.qualified === 'users')!
      .columns.find((c) => c.name === 'email')!;
    assert.equal(projectedEmail.nullable, false, 'the projection is happy');

    const result = await preview(session);
    assert.equal(result.findings[0]!.severity, 'blocking', 'reality is not');
    assert.equal(result.findings[0]!.rowCount, 12);
    assert.equal(result.blocking, true);
  });

  it('applies what it previewed, and nothing else', async () => {
    session = await freshSession();
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'session_applied',
      type: 'text',
      nullable: true,
    });

    const result = await preview(session);
    await session.apply(adapter, {
      token: result.token,
      destructive: result.destructive,
      confirmedDestructive: false,
    });

    const { rows } = await verifier.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'session_applied'`,
    );
    assert.equal(Number(rows[0].n), 1);
  });

  it('refuses to apply once the changeset has moved on', async () => {
    session = await freshSession();
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'first_change',
      type: 'text',
      nullable: true,
    });

    const result = await preview(session);

    // The mistake: preview, then add one more edit, then apply. The second
    // edit would run having never been measured.
    session.add({ kind: 'drop_column', table: 'users', column: 'session_applied' });

    await assert.rejects(
      session.apply(adapter, {
        token: result.token,
        destructive: false,
        confirmedDestructive: false,
      }),
      /have changed since they were/,
    );
  });

  it('previews several changes in the order they would run', async () => {
    session = await freshSession();
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'ordered',
      type: 'text',
      nullable: true,
    });
    session.add({ kind: 'rename_column', table: 'users', column: 'ordered', to: 'reordered' });

    const result = await preview(session);
    assert.equal(result.findings.length, 2);
    assert.equal(result.findings[0]!.statementIndex, 0);
    assert.equal(result.findings[1]!.statementIndex, 1);
  });
});

describe('tableDetail', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await adapter?.dispose();
    await fixture?.stop();
  });

  it('returns structure, rules and real rows together', async () => {
    const detail = await adapter.tableDetail('users', 5);

    assert.equal(detail.table, 'users');
    assert.deepEqual(detail.primaryKey, ['id']);
    assert.equal(detail.rows, 100);
    assert.equal(detail.rowsEstimated, false);
    assert.equal(detail.sample.length, 5);
    assert.ok(detail.columns.some((c) => c.name === 'email'));
    assert.ok(detail.indexes.some((i) => i.primary), 'the primary key index is listed');
    assert.ok(detail.constraints.some((c) => c.type === 'primary key'));
  });

  it('orders the sample by primary key, so it does not shuffle between openings', async () => {
    const first = await adapter.tableDetail('users', 5);
    const second = await adapter.tableDetail('users', 5);

    assert.deepEqual(
      first.sample.map((r) => r['id']),
      second.sample.map((r) => r['id']),
    );
    assert.deepEqual(first.sample.map((r) => r['id']), [1, 2, 3, 4, 5]);
  });

  it('says so rather than throwing when the table is not there', async () => {
    await assert.rejects(adapter.tableDetail('no_such_table', 5), /Table not found/);
  });
});
