import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { findMigrations, readMigration } from '../migrations/discover';
import { readLedger } from '../migrations/ledger';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Finding migrations, and asking the database which it has run.
 *
 * The layouts are built on disk rather than mocked, because the thing being
 * tested is whether the shapes Prisma and Drizzle really produce are
 * recognised — and a mock of a directory layout only proves the mock matches
 * the code.
 */

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-migrations-'));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

describe('finding migrations', () => {
  it('recognises a Prisma project', () => {
    const root = scratch();
    write(
      path.join(root, 'prisma', 'migrations', '20240101120000_init', 'migration.sql'),
      'CREATE TABLE a (id int);',
    );
    write(
      path.join(root, 'prisma', 'migrations', '20240202130000_add_email', 'migration.sql'),
      'ALTER TABLE a ADD COLUMN email text;',
    );
    // Prisma leaves this alongside the migration folders.
    write(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"');

    const layout = findMigrations(root)!;
    assert.equal(layout.tool, 'prisma');
    assert.deepEqual(
      layout.migrations.map((migration) => migration.name),
      ['20240101120000_init', '20240202130000_add_email'],
      'directory names, which is exactly what the ledger records',
    );
    assert.match(readMigration(layout.migrations[1]!), /ADD COLUMN email/);
  });

  it('recognises a Drizzle project and keeps the timestamps', () => {
    const root = scratch();
    write(
      path.join(root, 'drizzle', 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1_710_000_000_000, tag: '0000_bent_wolverine', breakpoints: true },
          { idx: 1, version: '7', when: 1_720_000_000_000, tag: '0001_loud_thanos', breakpoints: true },
        ],
      }),
    );
    write(path.join(root, 'drizzle', '0000_bent_wolverine.sql'), 'CREATE TABLE a (id int);');
    write(path.join(root, 'drizzle', '0001_loud_thanos.sql'), 'DROP TABLE a;');

    const layout = findMigrations(root)!;
    assert.equal(layout.tool, 'drizzle');
    assert.deepEqual(
      layout.migrations.map((migration) => migration.createdAt),
      [1_710_000_000_000, 1_720_000_000_000],
      'Drizzle matches its ledger on when, not on the tag',
    );
  });

  it('ignores a journal entry whose file is missing', () => {
    const root = scratch();
    write(
      path.join(root, 'drizzle', 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ when: 1, tag: 'gone' }, { when: 2, tag: 'here' }] }),
    );
    write(path.join(root, 'drizzle', 'here.sql'), 'SELECT 1;');

    const layout = findMigrations(root)!;
    assert.deepEqual(
      layout.migrations.map((migration) => migration.name),
      ['here'],
    );
  });

  it('falls back to a plain folder of SQL files, in order', () => {
    const root = scratch();
    write(path.join(root, 'migrations', '0002_second.sql'), 'SELECT 2;');
    write(path.join(root, 'migrations', '0001_first.sql'), 'SELECT 1;');
    write(path.join(root, 'migrations', 'notes.md'), 'not a migration');

    const layout = findMigrations(root)!;
    assert.equal(layout.tool, 'plain');
    assert.deepEqual(
      layout.migrations.map((migration) => migration.name),
      ['0001_first.sql', '0002_second.sql'],
    );
  });

  it('prefers Prisma when a project has both', () => {
    // Some projects keep an old migrations folder around. The tool with a
    // ledger is the one worth reading, because it is the one that can say
    // what has already been applied.
    const root = scratch();
    write(path.join(root, 'migrations', 'old.sql'), 'SELECT 1;');
    write(path.join(root, 'prisma', 'migrations', '20240101_init', 'migration.sql'), 'SELECT 1;');

    assert.equal(findMigrations(root)!.tool, 'prisma');
  });

  it('finds nothing in a project with no migrations', () => {
    assert.equal(findMigrations(scratch()), undefined);
  });

  it('finds nothing when the folder exists but is empty', () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
    assert.equal(findMigrations(root), undefined);
  });
});

describe('the ledger', () => {
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

  function prismaProject(): ReturnType<typeof findMigrations> {
    const root = scratch();
    for (const name of ['20240101_init', '20240202_add_email', '20240303_drop_phone']) {
      write(path.join(root, 'prisma', 'migrations', name, 'migration.sql'), 'SELECT 1;');
    }
    return findMigrations(root);
  }

  it('treats a database with no ledger table as having run nothing', async () => {
    const layout = prismaProject()!;
    const status = await readLedger(adapter, layout);

    assert.equal(status.pending.length, 3);
    assert.equal(status.appliedCount, 0);
    assert.match(status.note!, /No _prisma_migrations table/);
  });

  it('reports only what the database has not run', async () => {
    await db.query(`
      CREATE TABLE _prisma_migrations (
        id             varchar(36) PRIMARY KEY,
        migration_name varchar(255) NOT NULL,
        finished_at    timestamptz,
        rolled_back_at timestamptz
      );
      INSERT INTO _prisma_migrations (id, migration_name, finished_at) VALUES
        ('1', '20240101_init', now()),
        ('2', '20240202_add_email', now());
    `);

    const status = await readLedger(adapter, prismaProject()!);
    assert.deepEqual(
      status.pending.map((migration) => migration.name),
      ['20240303_drop_phone'],
    );
    assert.equal(status.appliedCount, 2);
    assert.equal(status.note, undefined);
  });

  it('counts a migration that started and never finished as pending', async () => {
    // Prisma will not move past a failed migration, so previewing it is
    // exactly what someone in that state wants.
    await db.query(
      `INSERT INTO _prisma_migrations (id, migration_name, finished_at)
         VALUES ('3', '20240303_drop_phone', NULL)`,
    );

    const status = await readLedger(adapter, prismaProject()!);
    assert.deepEqual(
      status.pending.map((migration) => migration.name),
      ['20240303_drop_phone'],
    );
    await db.query(`DELETE FROM _prisma_migrations WHERE id = '3'`);
  });

  it('counts a rolled-back migration as pending', async () => {
    await db.query(
      `INSERT INTO _prisma_migrations (id, migration_name, finished_at, rolled_back_at)
         VALUES ('4', '20240303_drop_phone', now(), now())`,
    );

    const status = await readLedger(adapter, prismaProject()!);
    assert.ok(status.pending.some((migration) => migration.name === '20240303_drop_phone'));
    await db.query(`DELETE FROM _prisma_migrations WHERE id = '4'`);
  });

  it('reports a migration the database has run that this checkout does not have', async () => {
    // The signal that this is not the environment anyone thought it was.
    await db.query(
      `INSERT INTO _prisma_migrations (id, migration_name, finished_at)
         VALUES ('5', '20240404_from_someone_else', now())`,
    );

    const status = await readLedger(adapter, prismaProject()!);
    assert.deepEqual(status.unknownToRepo, ['20240404_from_someone_else']);
  });

  it('matches Drizzle on the timestamp its ledger actually stores', async () => {
    const root = scratch();
    write(
      path.join(root, 'drizzle', 'meta', '_journal.json'),
      JSON.stringify({
        entries: [
          { when: 1_710_000_000_000, tag: '0000_first' },
          { when: 1_720_000_000_000, tag: '0001_second' },
        ],
      }),
    );
    write(path.join(root, 'drizzle', '0000_first.sql'), 'SELECT 1;');
    write(path.join(root, 'drizzle', '0001_second.sql'), 'SELECT 1;');

    await db.query(`
      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (
        id         serial PRIMARY KEY,
        hash       text NOT NULL,
        created_at bigint
      );
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES ('whatever', 1710000000000);
    `);

    const status = await readLedger(adapter, findMigrations(root)!);
    assert.deepEqual(
      status.pending.map((migration) => migration.name),
      ['0001_second'],
      'matched on when, not on the tag the ledger never sees',
    );
  });
});

describe('finding operations for an engine that does not write SQL', () => {
  // "Preview Pending Migrations" answered "none found" for a MongoDB project
  // with a directory full of them, because it only ever looked for `.sql`.
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-mongo-migrations-'));
    const operations = path.join(root, 'operations');
    fs.mkdirSync(operations);

    fs.writeFileSync(
      path.join(operations, '0001_cleanup.mongodb.js'),
      'db.users.deleteMany({ tier: "free" })\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(operations, '0002_backfill.js'),
      'db.users.updateMany({}, { $set: { seen: true } })\n',
      'utf8',
    );
    // Not a migration. Present to make sure the filter is a filter.
    fs.writeFileSync(path.join(operations, 'notes.md'), 'nothing here\n', 'utf8');
  });

  it('finds .js operations when the engine is MongoDB', () => {
    const layout = findMigrations(root, 'mongo');

    assert.ok(layout, 'found nothing at all');
    assert.equal(layout.migrations.length, 2);
    assert.deepEqual(
      layout.migrations.map((one) => one.name),
      ['0001_cleanup.mongodb.js', '0002_backfill.js'],
      'and in order, because order is what "pending" means',
    );
  });

  it('finds none of them for an engine that writes SQL', () => {
    // A folder of JavaScript is not a folder of migrations for Postgres, and
    // offering to run it as SQL would be worse than finding nothing.
    assert.equal(findMigrations(root, 'postgres'), undefined);
  });

  it('still finds a plain SQL folder for the engines that use one', () => {
    const sqlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-sql-migrations-'));
    const directory = path.join(sqlRoot, 'migrations');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, '0001_init.sql'), 'CREATE TABLE a (id int);\n', 'utf8');

    const layout = findMigrations(sqlRoot, 'postgres');
    assert.ok(layout);
    assert.equal(layout.migrations.length, 1);

    // And not for MongoDB, which cannot run it.
    assert.equal(findMigrations(sqlRoot, 'mongo'), undefined);
  });

  it('defaults to SQL when nothing says otherwise', () => {
    const sqlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-default-migrations-'));
    const directory = path.join(sqlRoot, 'migrations');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, '0001_init.sql'), 'SELECT 1;\n', 'utf8');

    assert.ok(findMigrations(sqlRoot));
  });
});
