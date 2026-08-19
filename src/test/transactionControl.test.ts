import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskLiterals, statementStarts } from '../parser/mask';
import { findTransactionControl } from '../parser/transactionControl';

describe('maskLiterals', () => {
  const masked = (sql: string): string => maskLiterals(sql);

  it('preserves length and newlines', () => {
    const sql = "SELECT 'a';\n-- note\nSELECT 1;";
    assert.equal(masked(sql).length, sql.length);
    assert.equal((masked(sql).match(/\n/g) ?? []).length, 2);
  });

  it('blanks line comments', () => {
    assert.equal(masked('SELECT 1; -- COMMIT').includes('COMMIT'), false);
  });

  it('blanks nested block comments', () => {
    const sql = 'SELECT 1; /* outer /* inner COMMIT */ still inside */ SELECT 2;';
    const out = masked(sql);
    assert.equal(out.includes('COMMIT'), false);
    assert.equal(out.includes('SELECT 2'), true);
  });

  it('blanks single-quoted strings, including doubled quotes', () => {
    const sql = "UPDATE t SET note = 'it''s a COMMIT; really' WHERE id = 1;";
    const out = masked(sql);
    assert.equal(out.includes('COMMIT'), false);
    assert.equal(out.includes('WHERE id = 1'), true);
  });

  it('blanks quoted identifiers', () => {
    assert.equal(masked('SELECT "COMMIT" FROM t;').includes('COMMIT'), false);
  });

  it('blanks dollar-quoted bodies of any tag', () => {
    const sql = "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN COMMIT; END $body$ LANGUAGE plpgsql;";
    const out = masked(sql);
    assert.equal(out.includes('COMMIT'), false);
    assert.equal(out.includes('LANGUAGE plpgsql'), true);
  });

  it('leaves a semicolon inside a string uncounted as a boundary', () => {
    const sql = "INSERT INTO t VALUES ('a;b'); SELECT 1;";
    assert.equal(statementStarts(masked(sql)).length, 2);
  });
});

describe('findTransactionControl', () => {
  const cases: Array<[string, string | null]> = [
    ['UPDATE users SET tier = $1', null],
    ['DELETE FROM users WHERE id = 1;', null],
    ['COMMIT', 'COMMIT'],
    ['commit;', 'COMMIT'],
    ['UPDATE users SET a = 1; COMMIT;', 'COMMIT'],
    ['  \n  END;', 'END'],
    ['ROLLBACK;', 'ROLLBACK'],
    ['BEGIN;', 'BEGIN'],
    ['ABORT;', 'ABORT'],
    ['START TRANSACTION;', 'START TRANSACTION'],
    ['SAVEPOINT sp1;', 'SAVEPOINT'],
    ['RELEASE SAVEPOINT sp1;', 'RELEASE'],
    ["PREPARE TRANSACTION 'gid';", 'PREPARE TRANSACTION'],
    // A CASE expression ends with END, mid-statement — not transaction control.
    ["SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t;", null],
    // An ordinary prepared statement is fine.
    ['PREPARE plan AS SELECT * FROM users;', null],
    // Comments and strings are not statements.
    ['SELECT 1; -- COMMIT', null],
    ["SELECT 'COMMIT';", null],
  ];

  for (const [sql, expected] of cases) {
    it(`${expected === null ? 'allows' : `flags ${expected} in`} ${JSON.stringify(sql)}`, () => {
      assert.equal(findTransactionControl(sql), expected);
    });
  }
});
