import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { downMigration } from '../edit/down';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The migration that undoes the migration.
 *
 * Almost every test here follows the same shape: generate the down migration,
 * apply the change for real, run the down migration, and then ask the
 * catalogue whether the schema is back. Asserting on the generated text alone
 * would only prove the generator agrees with itself, and a down migration is
 * exactly the artefact nobody runs until the night it has to work.
 */

describe('down migrations', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let db: Client;

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
    await db.query('DROP TABLE IF EXISTS notes CASCADE');
    await db.query(`
      CREATE TABLE notes (
        id       serial PRIMARY KEY,
        author   text NOT NULL,
        body     text,
        priority int NOT NULL DEFAULT 3,
        CONSTRAINT priority_range CHECK (priority BETWEEN 1 AND 5)
      );
      CREATE INDEX notes_author ON notes (author);
      INSERT INTO notes (author, body) VALUES ('ana', 'first'), ('bo', 'second');
    `);
  });

  /** Column shape as the catalogue has it, which is what "back" has to mean. */
  async function shapeOf(column: string) {
    const { rows } = await db.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'notes'::regclass AND a.attname = $1 AND NOT a.attisdropped`,
      [column],
    );
    return rows[0];
  }

  it('drops a column that was added', async () => {
    const down = await downMigration(adapter, [
      { kind: 'add_column', table: 'notes', column: 'tag', type: 'text', nullable: true },
    ]);

    await db.query('ALTER TABLE notes ADD COLUMN tag text');
    await db.query(down.sql);

    assert.equal(await shapeOf('tag'), undefined);
    assert.deepEqual(down.gaps, [], 'adding a column takes nothing away, so nothing is lost');
  });

  it('puts back a dropped column with its real type and default', async () => {
    // The point of generating this before the change: the migration file says
    // "drop priority" and nothing else. Only the live schema knows it was an
    // int defaulting to 3.
    const down = await downMigration(adapter, [
      { kind: 'drop_column', table: 'notes', column: 'priority' },
    ]);

    await db.query('ALTER TABLE notes DROP COLUMN priority');
    await db.query(down.sql);

    const shape = await shapeOf('priority');
    assert.equal(shape.type, 'integer');
    assert.equal(shape.def, '3');
  });

  it('leaves the restored column nullable even though it was NOT NULL', async () => {
    // It comes back empty. A NOT NULL on an empty column fails on the first
    // row, so it is restored after the rescue file, not before.
    const down = await downMigration(adapter, [
      { kind: 'drop_column', table: 'notes', column: 'author' },
    ]);

    await db.query('ALTER TABLE notes DROP COLUMN author');
    await db.query(down.sql);

    assert.equal((await shapeOf('author')).not_null, false);
    assert.ok(
      down.gaps.some((gap) => /comes back empty/.test(gap)),
      'and it says so rather than implying the data is back',
    );
  });

  it('renames a column back', async () => {
    const down = await downMigration(adapter, [
      { kind: 'rename_column', table: 'notes', column: 'body', to: 'content' },
    ]);

    await db.query('ALTER TABLE notes RENAME COLUMN body TO content');
    await db.query(down.sql);

    assert.ok(await shapeOf('body'));
    assert.equal(await shapeOf('content'), undefined);
  });

  it('casts a type back', async () => {
    const down = await downMigration(adapter, [
      { kind: 'alter_type', table: 'notes', column: 'priority', to: 'bigint' },
    ]);

    await db.query('ALTER TABLE notes ALTER COLUMN priority TYPE bigint');
    await db.query(down.sql);

    assert.equal((await shapeOf('priority')).type, 'integer');
    assert.ok(
      down.gaps.some((gap) => /narrowing cast/.test(gap)),
      'going back from bigint to integer can fail, and that is worth saying',
    );
  });

  it('restores a default that was replaced', async () => {
    const down = await downMigration(adapter, [
      { kind: 'set_default', table: 'notes', column: 'priority', expression: '9' },
    ]);

    await db.query('ALTER TABLE notes ALTER COLUMN priority SET DEFAULT 9');
    await db.query(down.sql);

    assert.equal((await shapeOf('priority')).def, '3');
  });

  it('drops a default that did not exist before', async () => {
    const down = await downMigration(adapter, [
      { kind: 'set_default', table: 'notes', column: 'body', expression: `'none'` },
    ]);

    await db.query(`ALTER TABLE notes ALTER COLUMN body SET DEFAULT 'none'`);
    await db.query(down.sql);

    assert.equal((await shapeOf('body')).def, null);
  });

  it('drops an index that was added', async () => {
    const down = await downMigration(adapter, [
      {
        kind: 'add_index',
        table: 'notes',
        columns: ['body'],
        unique: false,
        concurrently: false,
        name: 'notes_body_idx',
      },
    ]);

    await db.query('CREATE INDEX notes_body_idx ON notes (body)');
    await db.query(down.sql);

    const { rows } = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'notes_body_idx'`,
    );
    assert.equal(rows.length, 0);
  });

  it('guesses the name Postgres would pick when none was given', async () => {
    const down = await downMigration(adapter, [
      { kind: 'add_index', table: 'notes', columns: ['body'], unique: false, concurrently: false },
    ]);

    await db.query('CREATE INDEX ON notes (body)');
    await db.query(down.sql);

    const { rows } = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'notes_body_idx'`,
    );
    assert.equal(rows.length, 0, 'the guessed name is the one the server actually used');
  });

  it('puts back a dropped constraint, definition and all', async () => {
    const down = await downMigration(adapter, [
      { kind: 'drop_constraint', table: 'notes', name: 'priority_range' },
    ]);

    await db.query('ALTER TABLE notes DROP CONSTRAINT priority_range');
    await db.query(down.sql);

    const { rows } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'priority_range'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].def, /priority >= 1/);

    // And it still does its job, which is the only reason to restore it.
    await assert.rejects(() => db.query('INSERT INTO notes (author, priority) VALUES (99, 99)'));
  });

  it('rebuilds a dropped table with its keys, constraints and indexes', async () => {
    const down = await downMigration(adapter, [{ kind: 'drop_table', table: 'notes' }]);

    await db.query('DROP TABLE notes');
    await db.query(down.sql);

    const columns = await db.query(
      `SELECT attname FROM pg_attribute
        WHERE attrelid = 'notes'::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.attname),
      ['id', 'author', 'body', 'priority'],
    );

    const constraints = await db.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'notes'::regclass ORDER BY conname`,
    );
    assert.ok(constraints.rows.some((row) => row.conname === 'priority_range'));

    const indexes = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'notes' ORDER BY indexname`,
    );
    assert.deepEqual(
      indexes.rows.map((row) => row.indexname),
      ['notes_author', 'notes_pkey'],
    );

    assert.ok(
      down.gaps.some((gap) => /Triggers, rules, comments, grants/.test(gap)),
      'what it does not rebuild is listed rather than left to be discovered',
    );
  });

  it('brings a serial column back as a serial, not as an orphaned default', async () => {
    // Dropping a serial column drops the sequence it owns. Restoring the
    // column with its literal nextval() default points at a relation that no
    // longer exists, and the failure only shows up on the first insert.
    const down = await downMigration(adapter, [
      { kind: 'drop_column', table: 'notes', column: 'id' },
    ]);

    await db.query('ALTER TABLE notes DROP COLUMN id');
    await db.query(down.sql);
    await db.query(`INSERT INTO notes (author) VALUES ('cy')`);

    const { rows } = await db.query(`SELECT id FROM notes WHERE author = 'cy'`);
    assert.equal(typeof rows[0].id, 'number', 'the sequence is generating again');
  });

  it('rebuilds an identity column as an identity column', async () => {
    // An identity column has no default expression at all, so a rebuild that
    // only looks at defaults produces a plain integer that has silently
    // stopped generating anything.
    await db.query('DROP TABLE IF EXISTS marks');
    await db.query(`
      CREATE TABLE marks (
        id  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        tag text
      );
    `);

    const down = await downMigration(adapter, [{ kind: 'drop_table', table: 'marks' }]);
    await db.query('DROP TABLE marks');
    await db.query(down.sql);
    await db.query(`INSERT INTO marks (tag) VALUES ('x')`);

    const { rows } = await db.query(
      `SELECT attidentity FROM pg_attribute
        WHERE attrelid = 'marks'::regclass AND attname = 'id'`,
    );
    assert.equal(rows[0].attidentity, 'a', 'still GENERATED ALWAYS');
    await db.query('DROP TABLE marks');
  });

  it('drops a table that was created', async () => {
    const down = await downMigration(adapter, [
      { kind: 'create_table', table: 'scratch', columns: [{ name: 'id', type: 'int', nullable: false }] },
    ]);

    await db.query('CREATE TABLE scratch (id int)');
    await db.query(down.sql);

    const { rows } = await db.query(`SELECT to_regclass('scratch') AS t`);
    assert.equal(rows[0].t, null);
  });

  it('undoes a sequence back to front', async () => {
    // Undoing in the original order would try to drop a column from a table it
    // has not put back yet.
    const down = await downMigration(adapter, [
      { kind: 'drop_column', table: 'notes', column: 'body' },
      { kind: 'add_column', table: 'notes', column: 'tag', type: 'text', nullable: true },
    ]);

    assert.match(down.statements[0]!, /DROP COLUMN "tag"/);
    assert.match(down.statements[1]!, /ADD COLUMN "body"/);

    await db.query('ALTER TABLE notes DROP COLUMN body');
    await db.query('ALTER TABLE notes ADD COLUMN tag text');
    await db.query(down.sql);

    assert.ok(await shapeOf('body'));
    assert.equal(await shapeOf('tag'), undefined);
  });

  describe('what it refuses to pretend', () => {
    it('does not claim to restore a deleted row', async () => {
      const down = await downMigration(adapter, [
        { kind: 'delete_row', table: 'notes', key: { id: 1 } },
      ]);
      assert.deepEqual(down.statements, []);
      assert.match(down.sql, /Nothing here is reversible by DDL alone/);
      assert.ok(down.gaps.some((gap) => /rescue file/.test(gap)));
    });

    it('does not claim to remove an inserted row it cannot address', async () => {
      const down = await downMigration(adapter, [
        { kind: 'insert_row', table: 'notes', values: { author: 'cy' } },
      ]);
      assert.deepEqual(down.statements, []);
      assert.ok(down.gaps.some((gap) => /assigned by the server/.test(gap)));
    });

    it('says why an unnamed check cannot be dropped', async () => {
      const down = await downMigration(adapter, [
        { kind: 'add_check', table: 'notes', expression: 'priority > 0' },
      ]);
      assert.deepEqual(down.statements, []);
      assert.ok(down.gaps.some((gap) => /Name your constraints/.test(gap)));
    });

    it('writes the gaps into the file, not just into the object', async () => {
      const down = await downMigration(adapter, [
        { kind: 'drop_column', table: 'notes', column: 'author' },
      ]);
      assert.match(down.sql, /What this does NOT undo/);
      assert.match(down.sql, /comes back empty/);
    });
  });
});
