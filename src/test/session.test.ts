import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { analyzeStatements } from '../analysis/orchestrator';
import { DEFAULT_THRESHOLDS, Finding } from '../analysis/types';
import { PlanNode } from '../analysis/plan';
import { splitStatements } from '../parser/splitter';
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

  it('plans the statement against the table the statement actually saw', async () => {
    // The bug this pins: capturing the plan while the statement's effects were
    // still in place meant EXPLAIN ANALYZE re-ran against an already-modified
    // table. A DELETE whose rows had gone matched nothing the second time, so
    // the plan described an empty statement sitting next to a row count of
    // 33 — the two halves of the same row disagreeing.
    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: splitStatements(`DELETE FROM users WHERE tier = 'pro'`),
      thresholds: { ...DEFAULT_THRESHOLDS, explainAnalyze: true },
      onFinding: (finding) => findings.push(finding),
    });

    const finding = findings[0]!;
    assert.equal(finding.rowCount, 33);

    const plan = finding.plan!;
    assert.ok(plan, 'a plan was captured');

    // The scan the plan describes must have seen the same rows the statement
    // did, not zero.
    const scanned = deepest(plan.root);
    assert.ok(
      scanned.actualRows >= 33,
      `the plan saw ${scanned.actualRows} rows; the statement affected 33`,
    );

    const { rows } = await verifier.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE tier = 'pro'`,
    );
    assert.equal(Number(rows[0].n), 33, 'and running it twice still committed nothing');
  });

  it('creates a table for real, and it is usable afterwards', async () => {
    session = await freshSession();
    session.add({
      kind: 'create_table',
      table: 'invoices_from_ui',
      columns: [
        { name: 'id', type: 'bigserial', nullable: false, primaryKey: true },
        { name: 'note', type: 'text', nullable: true },
        { name: 'total_cents', type: 'integer', nullable: false },
      ],
    });

    const result = await preview(session);
    assert.equal(result.destructive, false, 'creating a table destroys nothing');

    await session.apply(adapter, {
      token: result.token,
      destructive: false,
      confirmedDestructive: false,
    });

    // The generated CREATE TABLE has never been executed before this test.
    // bigserial with an inline PRIMARY KEY has to actually produce a usable
    // table, not merely parse.
    await verifier.query(`INSERT INTO invoices_from_ui (total_cents) VALUES (500)`);
    const { rows } = await verifier.query(`SELECT id, note, total_cents FROM invoices_from_ui`);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].id), 1, 'the serial handed out a value');
    assert.equal(rows[0].note, null);

    const detail = await adapter.tableDetail('invoices_from_ui', 5);
    assert.deepEqual(detail.primaryKey, ['id'], 'and the key really is one');
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

/** The bottom-most node, which is the one that reads the table. */
function deepest(node: PlanNode): PlanNode {
  return node.children.length > 0 ? deepest(node.children[0]!) : node;
}

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

  describe('finding one row among many', () => {
    it('matches a value in any column without being told which', async () => {
      // The user is looking for a value, not writing a query, and does not know
      // or care which column holds it.
      const detail = await adapter.tableDetail('users', 25, 'dupe@example.com');

      assert.ok(detail.sample.length > 0);
      assert.equal(detail.filter, 'dupe@example.com');
      for (const row of detail.sample) {
        assert.equal(row['email'], 'dupe@example.com');
      }
    });

    it('matches case-insensitively, and on a partial value', async () => {
      const detail = await adapter.tableDetail('users', 25, 'DUPE@EXAM');
      assert.ok(detail.sample.length > 0, 'found it despite the case and the truncation');
    });

    it('matches a number as readily as text', async () => {
      // Every column is cast to text, so an id is searchable without the user
      // having to think about types.
      const detail = await adapter.tableDetail('users', 25, '42');
      assert.ok(detail.sample.some((row) => String(row['id']).includes('42')));
    });

    it('returns nothing rather than everything when nothing matches', async () => {
      const detail = await adapter.tableDetail('users', 25, 'no-row-contains-this-string');
      assert.deepEqual(detail.sample, []);
      assert.equal(detail.matched, 0, 'the filter ran and matched nothing');
    });

    it('treats a blank filter as no filter', async () => {
      const detail = await adapter.tableDetail('users', 5, '   ');
      assert.equal(detail.sample.length, 5);
      assert.equal(detail.filter, undefined);
    });

    it('does not let a search term reach the SQL as SQL', async () => {
      // The term is bound; only column names are interpolated, and those come
      // from the catalog.
      const detail = await adapter.tableDetail('users', 25, `' OR 1=1 --`);
      assert.deepEqual(detail.sample, [], 'matched literally, as a string');

      const stillThere = await adapter.countRows('users');
      assert.equal(stillThere, 100);
    });
  });
});
