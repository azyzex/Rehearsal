import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { classify } from '../parser/classifier';
import { splitStatements, statementAt } from '../parser/splitter';

const TESTBED = path.resolve(__dirname, '..', '..', 'testbed', 'postgres-shop', 'migrations');

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    const statements = splitStatements(`SELECT 1; SELECT 2;`);
    assert.deepEqual(
      statements.map((s) => s.sql),
      ['SELECT 1', 'SELECT 2'],
    );
  });

  it('ignores a semicolon inside a string', () => {
    const statements = splitStatements(`INSERT INTO orgs (name) VALUES ('acme; holdings');`);
    assert.equal(statements.length, 1);
  });

  it('ignores a semicolon inside a dollar-quoted body', () => {
    const sql = `CREATE FUNCTION f() RETURNS trigger AS $$
BEGIN
  NEW.x := 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;
    const statements = splitStatements(sql);
    assert.equal(statements.length, 1);
    assert.ok(statements[0]!.sql.includes('LANGUAGE plpgsql'));
  });

  it('drops comment-only and empty segments', () => {
    const statements = splitStatements(`-- just a note\n\n;;\nSELECT 1;\n-- trailing\n`);
    assert.equal(statements.length, 1);
    assert.equal(statements[0]!.sql, 'SELECT 1');
  });

  it('excludes leading comments from the statement text', () => {
    const statements = splitStatements(`-- explain the thing\nDELETE FROM carts;`);
    assert.equal(statements[0]!.sql, 'DELETE FROM carts');
  });

  it('reports the line each statement starts and ends on', () => {
    const statements = splitStatements(`SELECT 1;\n\nUPDATE users\n   SET a = 1;\n`);
    assert.equal(statements[0]!.startLine, 0);
    assert.equal(statements[1]!.startLine, 2);
    assert.equal(statements[1]!.endLine, 3);
  });

  it('handles a file with no trailing semicolon', () => {
    assert.equal(splitStatements('SELECT 1').length, 1);
  });

  it('survives the torture fixture with the documented statement count', () => {
    const sql = fs.readFileSync(path.join(TESTBED, 'parser_torture.sql'), 'utf8');
    const statements = splitStatements(sql);
    assert.equal(statements.length, 9, statements.map((s) => s.sql.slice(0, 40)).join('\n'));
  });

  it('never counts a statement that only exists inside a comment', () => {
    const sql = fs.readFileSync(path.join(TESTBED, 'parser_torture.sql'), 'utf8');
    const statements = splitStatements(sql);
    assert.equal(
      statements.some((s) => /DROP\s+TABLE/i.test(s.sql)),
      false,
      'the DROP TABLE inside the nested comment must not be a statement',
    );
  });
});

describe('statementAt', () => {
  const text = `SELECT 1;\nUPDATE users SET a = 1;\n`;
  const statements = splitStatements(text);

  it('finds the statement under an offset', () => {
    assert.equal(statementAt(statements, text.indexOf('UPDATE'))!.index, 1);
  });

  it('falls back to the nearest statement above', () => {
    assert.equal(statementAt(statements, text.length - 1)!.index, 1);
  });
});

describe('classify', () => {
  const kindOf = (sql: string) => classify(sql).kind;

  it('recognises DML', () => {
    assert.equal(kindOf(`UPDATE users SET tier = 'free' WHERE tier = 'pro'`), 'update');
    assert.equal(kindOf(`DELETE FROM carts`), 'delete');
    assert.equal(kindOf(`INSERT INTO orgs (name) VALUES ('x')`), 'insert');
    assert.equal(kindOf(`SELECT * FROM users`), 'select');
  });

  it('extracts the target table, schema-qualified or quoted', () => {
    assert.equal(classify(`UPDATE public.users SET a = 1`).table, 'public.users');
    assert.equal(classify(`UPDATE "user table" SET a = 1`).table, 'user table');
    assert.equal(classify(`DELETE FROM ONLY carts WHERE x`).table, 'carts');
  });

  it('notices a missing WHERE clause', () => {
    assert.equal(classify(`DELETE FROM carts`).hasWhere, false);
    assert.equal(classify(`DELETE FROM carts WHERE abandoned`).hasWhere, true);
  });

  it('does not mistake a subquery WHERE for the statement WHERE', () => {
    assert.equal(
      classify(`DELETE FROM carts WHERE user_id IN (SELECT id FROM users WHERE tier = 'free')`)
        .hasWhere,
      true,
    );
    assert.equal(
      classify(`DELETE FROM carts USING (SELECT id FROM users WHERE tier = 'x') s`).hasWhere,
      false,
      'the only WHERE here belongs to the subquery',
    );
  });

  it('captures a table alias, which the RETURNING list needs', () => {
    // Without this, `DELETE FROM accounts USING users ... RETURNING id` is
    // ambiguous and the preview fails with a parser error instead of a count.
    assert.equal(classify('UPDATE users u SET a = 1').alias, 'u');
    assert.equal(classify('UPDATE users AS u SET a = 1').alias, 'u');
    assert.equal(classify('DELETE FROM accounts a USING users WHERE a.x = 1').alias, 'a');
  });

  it('does not mistake a keyword for an alias', () => {
    // `DELETE FROM accounts USING users` has no alias. Reading USING as one
    // produces `USING.id`, which is a worse failure than the ambiguity.
    assert.equal(classify('DELETE FROM accounts USING users WHERE x').alias, undefined);
    assert.equal(classify('DELETE FROM carts WHERE abandoned').alias, undefined);
    assert.equal(classify(`UPDATE users SET tier = 'free'`).alias, undefined);
    assert.equal(classify('DELETE FROM carts RETURNING id').alias, undefined);
  });

  it('notices an existing RETURNING clause', () => {
    assert.equal(classify(`DELETE FROM carts WHERE x RETURNING id`).hasReturning, true);
    assert.equal(classify(`DELETE FROM carts WHERE x`).hasReturning, false);
  });

  it('recognises column-scoped DDL', () => {
    const drop = classify(`ALTER TABLE users DROP COLUMN phone_number`);
    assert.equal(drop.kind, 'drop_column');
    assert.equal(drop.table, 'users');
    assert.equal(drop.column, 'phone_number');

    const notNull = classify(`ALTER TABLE users ALTER COLUMN email SET NOT NULL`);
    assert.equal(notNull.kind, 'set_not_null');
    assert.equal(notNull.column, 'email');

    assert.equal(classify(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`).kind, 'drop_not_null');

    const retype = classify(`ALTER TABLE orders ALTER COLUMN total_cents TYPE bigint`);
    assert.equal(retype.kind, 'alter_column_type');
    assert.equal(retype.newType, 'bigint');

    const retypeUsing = classify(
      `ALTER TABLE orders ALTER COLUMN status TYPE varchar(20) USING status::varchar`,
    );
    assert.equal(retypeUsing.newType, 'varchar(20)');

    const add = classify(`ALTER TABLE users ADD COLUMN last_seen_at timestamptz`);
    assert.equal(add.kind, 'add_column');
    assert.equal(add.column, 'last_seen_at');
  });

  it('recognises constraints and pulls out what the probe needs', () => {
    const check = classify(
      `ALTER TABLE orders ADD CONSTRAINT orders_total_positive CHECK (total_cents > 0)`,
    );
    assert.equal(check.kind, 'add_check');
    assert.equal(check.checkPredicate, 'total_cents > 0');

    const nested = classify(`ALTER TABLE t ADD CHECK (a > 0 AND (b < 1 OR c IS NULL))`);
    assert.equal(nested.checkPredicate, 'a > 0 AND (b < 1 OR c IS NULL)');

    const fk = classify(
      `ALTER TABLE users ADD CONSTRAINT users_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)`,
    );
    assert.equal(fk.kind, 'add_foreign_key');
    assert.deepEqual(fk.columns, ['org_id']);
    assert.equal(fk.references?.table, 'orgs');
    assert.deepEqual(fk.references?.columns, ['id']);

    const unique = classify(`ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)`);
    assert.equal(unique.kind, 'add_unique');
    assert.deepEqual(unique.columns, ['email']);
  });

  it('recognises index creation and whether it locks', () => {
    const plain = classify(`CREATE INDEX idx_orders_user_id ON orders (user_id)`);
    assert.equal(plain.kind, 'create_index');
    assert.equal(plain.table, 'orders');
    assert.equal(plain.concurrently, false);
    assert.deepEqual(plain.columns, ['user_id']);

    const safe = classify(`CREATE INDEX CONCURRENTLY idx_x ON orders (status)`);
    assert.equal(safe.concurrently, true);

    const ordered = classify(`CREATE INDEX idx_orders_placed_at ON orders (placed_at DESC)`);
    assert.deepEqual(ordered.columns, ['placed_at']);
  });

  it('recognises the remaining destructive shapes', () => {
    assert.equal(classify(`TRUNCATE audit_log`).kind, 'truncate');
    assert.equal(classify(`TRUNCATE TABLE ONLY audit_log`).table, 'audit_log');
    assert.equal(classify(`DROP TABLE IF EXISTS carts`).kind, 'drop_table');
    assert.equal(classify(`ALTER TABLE users RENAME COLUMN a TO b`).kind, 'rename_column');
    assert.equal(classify(`ALTER TABLE users RENAME TO people`).kind, 'rename_table');
    assert.equal(classify(`CREATE TABLE shipping_zones (id serial PRIMARY KEY)`).kind, 'create_table');
  });

  it('is not fooled by keywords inside strings or comments', () => {
    assert.equal(kindOf(`INSERT INTO notes (body) VALUES ('DROP TABLE users')`), 'insert');
    assert.equal(kindOf(`SELECT 1 -- DELETE FROM users`), 'select');
  });

  it('falls through to other rather than guessing', () => {
    assert.equal(kindOf(`GRANT SELECT ON users TO analyst`), 'other');
    assert.equal(kindOf(`CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql`), 'other');
  });
});

describe('classify against the testbed migrations', () => {
  const expected: Record<string, string[]> = {
    '0002_drop_phone_number.sql': ['drop_column'],
    '0003_email_not_null.sql': ['set_not_null'],
    '0004_index_orders.sql': ['create_index', 'create_index'],
    '0005_retire_free_tier.sql': ['update', 'update', 'update'],
    '0006_add_constraints.sql': ['add_foreign_key', 'add_foreign_key', 'add_unique', 'add_check'],
    '0007_update.sql': ['drop_column', 'set_not_null', 'create_index', 'add_column'],
    '0008_cleanup_carts.sql': ['delete', 'delete', 'delete', 'truncate'],
    '0009_safe_changes.sql': ['drop_column', 'create_index', 'add_column', 'create_table'],
  };

  for (const [file, kinds] of Object.entries(expected)) {
    it(`classifies every statement in ${file}`, () => {
      const sql = fs.readFileSync(path.join(TESTBED, file), 'utf8');
      const actual = splitStatements(sql).map((s) => classify(s.sql).kind);
      assert.deepEqual(actual, kinds);
    });
  }
});
