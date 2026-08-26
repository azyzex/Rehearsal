import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { EditSession } from '../edit/session';
import { Thresholds } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Preview, then apply, with nothing in between.
 *
 * Reported from use: "these changes have not been previewed, or have changed
 * since they were" on a changeset that had just been previewed. The refusal is
 * correct machinery doing its job — the question is what made the token stop
 * matching, and the answer has to come from running the real sequence rather
 * than from reading it.
 */

const THRESHOLDS: Thresholds = {
  cautionRows: 100,
  destructiveRows: 1000,
  largeTable: 100_000,
  sampleSize: 5,
  explainAnalyze: false,
};

describe('previewing and then applying', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let db: Client;
  let session: EditSession;

  before(async () => {
    fixture = await startPostgres();
    db = new Client({ connectionString: fixture.connectionString });
    await db.connect();

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

  beforeEach(async () => {
    await db.query('ALTER TABLE users DROP COLUMN IF EXISTS poopy');
    session = new EditSession();
    session.setBaseline(await adapter.schemaSnapshot());
  });

  it('applies a single change that was just previewed', async () => {
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'poopy',
      type: 'text',
      nullable: true,
    });

    const preview = await session.preview(adapter, THRESHOLDS);
    const result = await session.apply(adapter, {
      token: preview.token,
      destructive: preview.destructive,
      confirmedDestructive: true,
    });

    assert.equal(result.applied, 1);
  });

  it('applies two changes that were previewed together', async () => {
    // The shape that was reported: a structure change and a row edit in one
    // changeset, previewed once, applied once.
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'poopy',
      type: 'text',
      nullable: true,
    });
    session.add({
      kind: 'update_row',
      table: 'users',
      key: { id: 1 },
      set: { tier: 'pro' },
    });

    const preview = await session.preview(adapter, THRESHOLDS);
    assert.equal(preview.findings.length, 2, 'both were measured');

    const result = await session.apply(adapter, {
      token: preview.token,
      destructive: preview.destructive,
      confirmedDestructive: true,
    });
    assert.equal(result.applied, 2);

    const { rows } = await db.query(`SELECT tier FROM users WHERE id = 1`);
    assert.equal(rows[0].tier, 'pro');
  });

  it('produces a finding for adding a column, rather than silence', async () => {
    // "I added a column and pressed preview and nothing happened." It does
    // produce a finding — the problem was that a sentence saying "Safe" is not
    // visible enough to read as an answer.
    session.add({
      kind: 'add_column',
      table: 'orgs',
      column: 'poopy',
      type: 'text',
      nullable: true,
    });

    const preview = await session.preview(adapter, THRESHOLDS);
    assert.equal(preview.findings.length, 1);
    assert.equal(preview.findings[0]!.severity, 'safe');
    assert.equal(preview.findings[0]!.classification.table, 'orgs');
  });

  it('shows the new column in the projected schema before it exists', async () => {
    // The other half of the same complaint. The whole point of previewing a
    // structure change is seeing the structure, and the projection is where
    // that lives.
    session.add({
      kind: 'add_column',
      table: 'orgs',
      column: 'poopy',
      type: 'text',
      nullable: true,
    });

    const projected = session.state().projected;
    const table = projected.tables.find((found) => found.name === 'orgs');

    assert.ok(table, 'the table is in the projection');
    assert.ok(
      table!.columns.some((column) => column.name === 'poopy'),
      'and the column that does not exist yet is drawn on it',
    );

    // And really is not in the database.
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'orgs' AND column_name = 'poopy'`,
    );
    assert.equal(rows[0].n, 0);
  });

  it('pairs each finding with the edit that produced it', async () => {
    // The panel lists edits; findings are numbered by their position among the
    // generated statements. Those agree only while every edit produces exactly
    // one statement, and nothing enforces that — so the pairing is explicit
    // rather than a coincidence that currently holds.
    session.add({ kind: 'add_column', table: 'users', column: 'poopy', type: 'text', nullable: true });
    session.add({ kind: 'update_row', table: 'users', key: { id: 1 }, set: { tier: 'pro' } });

    const preview = await session.preview(adapter, THRESHOLDS);

    assert.deepEqual(
      preview.findings.map((finding) => finding.editIndex),
      [0, 1],
    );
    assert.equal(preview.findings[0]!.classification.kind, 'add_column');
    assert.equal(preview.findings[1]!.classification.kind, 'update');
  });

  it('refuses once an edit has been added since the preview', async () => {
    // The refusal is correct and worth pinning: what was measured is no longer
    // what would run.
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'poopy',
      type: 'text',
      nullable: true,
    });
    const preview = await session.preview(adapter, THRESHOLDS);

    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'second',
      type: 'text',
      nullable: true,
    });

    await assert.rejects(
      () =>
        session.apply(adapter, {
          token: preview.token,
          destructive: false,
          confirmedDestructive: true,
        }),
      /have not been previewed, or have changed/,
    );
  });

  it('refuses once an edit has been removed since the preview', async () => {
    session.add({ kind: 'add_column', table: 'users', column: 'poopy', type: 'text', nullable: true });
    session.add({ kind: 'add_column', table: 'users', column: 'second', type: 'text', nullable: true });
    const preview = await session.preview(adapter, THRESHOLDS);

    session.removeAt(1);

    await assert.rejects(
      () =>
        session.apply(adapter, {
          token: preview.token,
          destructive: false,
          confirmedDestructive: true,
        }),
      /have not been previewed, or have changed/,
    );
  });

  it('still applies after the schema is re-read underneath it', async () => {
    // The panel re-reads the schema whenever the explorer refreshes, and that
    // must not silently invalidate a preview the user has just run.
    session.add({
      kind: 'add_column',
      table: 'users',
      column: 'poopy',
      type: 'text',
      nullable: true,
    });

    const preview = await session.preview(adapter, THRESHOLDS);
    session.setBaseline(await adapter.schemaSnapshot());

    const result = await session.apply(adapter, {
      token: preview.token,
      destructive: preview.destructive,
      confirmedDestructive: true,
    });
    assert.equal(result.applied, 1);
  });

  it('refuses a preview that finished after the changeset moved on', async () => {
    // The race the reported failure almost certainly was. Preview is async;
    // if an edit lands while it is in flight, the result that arrives
    // afterwards describes a changeset that no longer exists — and it used to
    // arrive carrying a token and enabling Apply.
    session.add({ kind: 'add_column', table: 'users', column: 'poopy', type: 'text', nullable: true });

    const inFlight = session.preview(adapter, THRESHOLDS);
    session.add({ kind: 'add_column', table: 'users', column: 'second', type: 'text', nullable: true });
    const stale = await inFlight;

    await assert.rejects(
      () =>
        session.apply(adapter, {
          token: stale.token,
          destructive: false,
          confirmedDestructive: true,
        }),
      /have not been previewed, or have changed/,
      'the token from the older changeset must not be accepted',
    );
  });

  it('applies twice in a row, previewing each time', async () => {
    session.add({ kind: 'add_column', table: 'users', column: 'poopy', type: 'text', nullable: true });
    const first = await session.preview(adapter, THRESHOLDS);
    await session.apply(adapter, {
      token: first.token,
      destructive: first.destructive,
      confirmedDestructive: true,
    });

    session.clear();
    session.setBaseline(await adapter.schemaSnapshot());
    session.add({ kind: 'update_row', table: 'users', key: { id: 2 }, set: { tier: 'pro' } });

    const second = await session.preview(adapter, THRESHOLDS);
    const result = await session.apply(adapter, {
      token: second.token,
      destructive: second.destructive,
      confirmedDestructive: true,
    });
    assert.equal(result.applied, 1);
  });
});
