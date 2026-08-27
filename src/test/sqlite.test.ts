import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SqliteAdapter, fileFrom, toPositional } from '../adapters/sqlite';
import { adapterFor } from '../adapters/select';
import { detect } from '../connection/detect';
import { dialectFor } from '../edit/dialect';
import { analyzeStatements } from '../analysis/orchestrator';
import { Finding } from '../analysis/types';
import { languageFor } from '../parser/language';

/**
 * The fourth engine, against a real database file.
 *
 * There is no server to start, which makes this the cheapest fixture in the
 * project: a temporary file, seeded in a few milliseconds, deleted afterwards.
 *
 * What is being checked is the pair of claims that made SQLite worth adding.
 * The first is that a schema change here is really executed and really rolled
 * back — the same promise Postgres makes and the one MySQL cannot. The second
 * is that the changes SQLite has no syntax for are refused by name rather than
 * exported as SQL that fails on the first line.
 */

describe('SQLite', () => {
  let file: string;
  let adapter: SqliteAdapter;

  before(async () => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-sqlite-')), 'app.db');

    const seed = new SqliteAdapter();
    await seed.connect({
      connectionString: file,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 2000,
      applicationName: 'vscode-dryrun',
    });
    await seed.runCommitted([
      { sql: 'CREATE TABLE orgs (id integer primary key, name text not null)', params: [] },
      {
        sql:
          'CREATE TABLE users (id integer primary key, ' +
          'org_id integer references orgs(id) on delete cascade, email text, nickname text)',
        params: [],
      },
      { sql: 'CREATE INDEX users_org ON users (org_id)', params: [] },
      { sql: "INSERT INTO orgs VALUES (1, 'Acme'), (2, 'Globex')", params: [] },
    ]);

    for (let i = 1; i <= 100; i += 1) {
      await seed.runCommitted([
        {
          sql: 'INSERT INTO users VALUES (?, ?, ?, ?)',
          params: [i, (i % 2) + 1, i <= 12 ? null : `u${i}@example.com`, `n${i}`],
        },
      ]);
    }
    await seed.dispose();

    adapter = new SqliteAdapter();
    await adapter.connect({
      connectionString: `sqlite:${file}`,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 2000,
      applicationName: 'vscode-dryrun',
    });
  });

  after(async () => {
    await adapter.dispose();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('is chosen by scheme, by extension, and by neither of the other three', () => {
    assert.equal(adapterFor('sqlite:./app.db').engine, 'sqlite');
    assert.equal(adapterFor('./app.db').engine, 'sqlite');
    assert.equal(adapterFor('file:data/app.sqlite3').engine, 'sqlite');
    assert.equal(adapterFor('postgres://u@h/db').engine, 'postgres');

    assert.equal(detect('sqlite:./app.db').engine, 'sqlite');
    assert.equal(detect('myhost:5432/db').engine, 'postgres', 'a host is not a file');
    assert.equal(fileFrom('sqlite://./app.db'), './app.db');
  });

  it('reads the schema it was pointed at', async () => {
    const snapshot = await adapter.schemaSnapshot();
    const users = snapshot.tables.find((table) => table.name === 'users');

    assert.ok(users, `read ${snapshot.tables.length} tables, none of them users`);
    assert.equal(users.rows, 100);
    assert.deepEqual(
      users.columns.map((column) => column.name),
      ['id', 'org_id', 'email', 'nickname'],
    );

    const keys = await adapter.foreignKeys(['users']);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.toTable, 'orgs');
  });

  it('counts the rows a NOT NULL would stop', async () => {
    assert.equal(await adapter.countRows('users'), 100);
    assert.equal(await adapter.countNonNull('users', 'email'), 88);
  });

  /**
   * The claim that justifies the engine.
   *
   * MySQL commits a schema change the instant it runs. SQLite does not, so the
   * preview here is a real execution — and if that were ever to stop being
   * true, this test is what says so.
   */
  it('really runs a schema change, and really takes it back', async () => {
    const seen = await adapter.withRollback(async (tx) => {
      await tx.query('ALTER TABLE users ADD COLUMN phone text');
      const info = await tx.query('PRAGMA table_info(users)');
      return info.rows.map((row) => String(row['name']));
    });

    assert.ok(seen.includes('phone'), 'the column was not added inside the transaction');

    const after = await adapter.tableColumns('users');
    assert.ok(
      !after.some((column) => column.name === 'phone'),
      'the rollback did not take the column back',
    );
  });

  it('refuses a COMMIT smuggled in from a migration file', async () => {
    await assert.rejects(
      adapter.withRollback(async (tx) => {
        await tx.query('COMMIT');
      }),
      /transaction-control/i,
    );
  });

  /**
   * The whole point of measuring a statement rather than reading it.
   *
   * `$1` is Postgres's placeholder and the analysis layer writes it everywhere.
   * SQLite reads it as a *named* parameter, which cannot be bound positionally,
   * so every statement carrying a value failed with "column index out of range"
   * until this existed.
   */
  it('translates numbered placeholders, and leaves quoted text alone', () => {
    assert.deepEqual(toPositional('WHERE a = $1 AND b = $2', ['x', 'y']), {
      sql: 'WHERE a = ? AND b = ?',
      params: ['x', 'y'],
    });

    // Out of order, which is the case a naive replace gets wrong.
    assert.deepEqual(toPositional('WHERE a = $2 AND b = $1', ['first', 'second']), {
      sql: 'WHERE a = ? AND b = ?',
      params: ['second', 'first'],
    });

    const literal = toPositional("WHERE note = 'costs $1 a month' AND id = $1", [7]);
    assert.equal(literal.sql, "WHERE note = 'costs $1 a month' AND id = ?");
    assert.deepEqual(literal.params, [7]);
  });

  it('measures a migration end to end, and leaves the file untouched', async () => {
    const language = languageFor('sqlite');
    const sql = [
      'DELETE FROM users WHERE org_id = 1;',
      'CREATE INDEX users_email ON users (email);',
      'ALTER TABLE users ADD COLUMN last_seen text;',
      'ALTER TABLE users DROP COLUMN nickname;',
    ].join('\n');

    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: language.split(sql),
      thresholds: {
        cautionRows: 100,
        destructiveRows: 1000,
        largeTable: 100_000,
        sampleSize: 5,
        explainAnalyze: false,
      },
      onFinding: (finding) => findings.push(finding),
    });

    assert.equal(findings.length, 4);
    assert.equal(findings[0]!.rowCount, 50, 'half the users belong to org 1');
    assert.equal(findings[3]!.severity, 'destructive');
    assert.match(findings[3]!.detail, /nickname/);

    // And none of it happened.
    const columns = await adapter.tableColumns('users');
    assert.ok(columns.some((column) => column.name === 'nickname'));
    assert.equal(await adapter.countRows('users'), 100);
  });

  /**
   * The cascade that may not happen.
   *
   * `PRAGMA foreign_keys` is per connection and off by default in SQLite, so
   * the same ON DELETE CASCADE is enforced or ignored depending on who runs the
   * delete — and Dry Run's connection is not the application's. The rows are
   * counted, because that is the larger blast radius; whether they go is the
   * part that cannot be assumed, so it is said.
   */
  it('counts the cascade, and will not promise it happens', async () => {
    const tree = await adapter.cascadeImpact('orgs', 'id = 1', []);

    assert.equal(tree.rows, 1);
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0]!.table, 'users');
    assert.equal(tree.children[0]!.rows, 50);
    assert.equal(tree.children[0]!.via?.action, 'cascade');

    assert.match(String(tree.truncated), /per connection/);
    assert.match(String(tree.truncated), /orphans/);
  });

  describe('the changes it has no syntax for', () => {
    const dialect = dialectFor('sqlite');

    it('refuses a retype, and says what the rebuild would take', () => {
      assert.throws(
        () =>
          dialect.toStatement(
            { kind: 'alter_type', table: 'users', column: 'email', to: 'integer' },
            0,
          ),
        /no ALTER COLUMN[\s\S]*replacement table/,
      );
    });

    it('refuses to make a column required', () => {
      assert.throws(
        () =>
          dialect.toStatement(
            { kind: 'set_nullability', table: 'users', column: 'email', nullable: false },
            0,
          ),
        /NOT NULL/,
      );
    });

    it('turns a unique constraint into the unique index that does the same job', () => {
      const statement = dialect.toStatement(
        { kind: 'add_unique', table: 'users', columns: ['email'] },
        0,
      );
      assert.match(statement.sql, /CREATE UNIQUE INDEX/);
      assert.match(statement.sql, /"users"/);
    });

    it('drops CONCURRENTLY from an index, which is a syntax error here', () => {
      const statement = dialect.toStatement(
        { kind: 'add_index', table: 'users', columns: ['email'], unique: false, concurrently: true },
        0,
      );
      assert.doesNotMatch(statement.sql, /CONCURRENTLY/);
    });
  });
});
