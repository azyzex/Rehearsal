import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { Edit } from '../edit/changeset';
import { captureRescue, literal } from '../edit/rescue';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The safety net.
 *
 * A rescue file that reads plausibly and does not restore anything is worse
 * than no rescue file, because it is believed. So every test here that captures
 * something goes on to destroy the data for real and run the captured SQL back,
 * and then checks the rows are the rows.
 */

describe('rescue', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let db: Client;

  before(async () => {
    fixture = await startPostgres();
    db = new Client({ connectionString: fixture.connectionString });
    await db.connect();

    await db.query(`
      CREATE TABLE inventory (
        sku      text PRIMARY KEY,
        label    text,
        count    int NOT NULL,
        notes    text,
        added_at timestamptz NOT NULL DEFAULT '2024-03-01T10:00:00Z'
      );
      INSERT INTO inventory (sku, label, count, notes) VALUES
        ('a-1', 'widget', 4, 'first'),
        ('a-2', 'gadget', 0, NULL),
        ('a-3', $$it's quoted$$, 7, E'back\\\\slash'),
        ('a-4', NULL, 12, 'fourth');
    `);

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await db?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  const capture = (edits: readonly Edit[], limit?: number) =>
    captureRescue(adapter, edits, limit === undefined ? {} : { limit });

  describe('what it keeps', () => {
    it('keeps nothing for a change that takes nothing away', async () => {
      const rescue = await capture([
        { kind: 'add_column', table: 'inventory', column: 'colour', type: 'text', nullable: true },
        { kind: 'add_index', table: 'inventory', columns: ['count'], unique: false, concurrently: false },
        { kind: 'rename_table', table: 'inventory', to: 'stock' },
      ]);
      assert.deepEqual(rescue.sections, []);
      assert.equal(rescue.sql, '');
    });

    it('skips a column that is null everywhere', async () => {
      await db.query('ALTER TABLE inventory ADD COLUMN unused text');
      const rescue = await capture([{ kind: 'drop_column', table: 'inventory', column: 'unused' }]);
      assert.deepEqual(rescue.sections, [], 'nothing is lost, so nothing is written');
      await db.query('ALTER TABLE inventory DROP COLUMN unused');
    });

    it('keeps only the rows that hold a value', async () => {
      const rescue = await capture([{ kind: 'drop_column', table: 'inventory', column: 'notes' }]);
      assert.equal(rescue.sections.length, 1);
      assert.equal(rescue.sections[0]!.total, 3, 'a-2 has no note');
      assert.deepEqual(
        rescue.sections[0]!.rows.map((row) => Object.keys(row)),
        [
          ['sku', 'notes'],
          ['sku', 'notes'],
          ['sku', 'notes'],
        ],
        'the key and the column, nothing else',
      );
    });

    it('says so when it could not capture everything', async () => {
      const rescue = await capture([{ kind: 'drop_table', table: 'inventory' }], 2);
      assert.equal(rescue.incomplete, true);
      assert.match(rescue.sections[0]!.truncated!, /Captured 2 of 4 rows/);
      assert.match(rescue.sql, /INCOMPLETE/);
    });
  });

  describe('the file actually restores the data', () => {
    it('puts back a dropped column', async () => {
      const rescue = await capture([{ kind: 'drop_column', table: 'inventory', column: 'notes' }]);

      await db.query('ALTER TABLE inventory DROP COLUMN notes');
      await db.query('ALTER TABLE inventory ADD COLUMN notes text');
      await db.query(rescue.sql);

      const { rows } = await db.query('SELECT sku, notes FROM inventory ORDER BY sku');
      assert.deepEqual(rows, [
        { sku: 'a-1', notes: 'first' },
        { sku: 'a-2', notes: null },
        { sku: 'a-3', notes: 'back\\slash' },
        { sku: 'a-4', notes: 'fourth' },
      ]);
    });

    it('puts back a whole dropped table', async () => {
      const rescue = await capture([{ kind: 'drop_table', table: 'inventory' }]);
      const before = await db.query('SELECT * FROM inventory ORDER BY sku');

      await db.query('DELETE FROM inventory');
      await db.query(rescue.sql);

      const restored = await db.query('SELECT * FROM inventory ORDER BY sku');
      assert.deepEqual(restored.rows, before.rows, 'every column, every value, unchanged');
    });

    it('puts back a deleted row', async () => {
      const rescue = await capture([
        { kind: 'delete_row', table: 'inventory', key: { sku: 'a-3' } },
      ]);

      await db.query(`DELETE FROM inventory WHERE sku = 'a-3'`);
      await db.query(rescue.sql);

      const { rows } = await db.query(`SELECT label, notes FROM inventory WHERE sku = 'a-3'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, "it's quoted", 'the apostrophe survived the round trip');
      assert.equal(rows[0].notes, 'back\\slash', 'and so did the backslash');
    });

    it('puts back the old value of an edited cell', async () => {
      const rescue = await capture([
        { kind: 'update_row', table: 'inventory', key: { sku: 'a-1' }, set: { count: 999 } },
      ]);

      await db.query(`UPDATE inventory SET count = 999 WHERE sku = 'a-1'`);
      await db.query(rescue.sql);

      const { rows } = await db.query(`SELECT count FROM inventory WHERE sku = 'a-1'`);
      assert.equal(rows[0].count, 4);
    });

    it('puts back values a narrowing type change would have rewritten', async () => {
      const rescue = await capture([
        { kind: 'alter_type', table: 'inventory', column: 'label', to: 'varchar(3)' },
      ]);

      await db.query(`ALTER TABLE inventory ALTER COLUMN label TYPE varchar(3) USING left(label, 3)`);
      const { rows: truncated } = await db.query(
        `SELECT label FROM inventory WHERE sku = 'a-1'`,
      );
      assert.equal(truncated[0].label, 'wid', 'the change really did lose data');

      await db.query('ALTER TABLE inventory ALTER COLUMN label TYPE text');
      await db.query(rescue.sql);

      const { rows } = await db.query(`SELECT label FROM inventory WHERE sku = 'a-1'`);
      assert.equal(rows[0].label, 'widget');
    });
  });

  describe('values', () => {
    it('escapes what has to be escaped', () => {
      assert.equal(literal(null), 'NULL');
      assert.equal(literal(undefined), 'NULL');
      assert.equal(literal(4), '4');
      assert.equal(literal(true), 'TRUE');
      assert.equal(literal("it's"), "'it''s'");
      assert.equal(literal(new Date('2024-03-01T10:00:00Z')), "'2024-03-01T10:00:00.000Z'");
      assert.equal(literal({ a: 1 }), `'{"a":1}'`);
    });

    it('writes a backslash so the server reads it back as one', async () => {
      // Without the E prefix this depends on standard_conforming_strings, and
      // a rescue file whose meaning depends on a server setting is not a
      // rescue file.
      const { rows } = await db.query(`SELECT ${literal('a\\b')} AS v`);
      assert.equal(rows[0].v, 'a\\b');
    });

    it('round-trips a value that is only quotes and backslashes', async () => {
      const nasty = `'"\\''\\\\`;
      const { rows } = await db.query(`SELECT ${literal(nasty)} AS v`);
      assert.equal(rows[0].v, nasty);
    });
  });
});
