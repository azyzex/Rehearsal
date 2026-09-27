import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explainStatementError } from '../analysis/statementErrors';

/**
 * Explanations for failed statements are regular expressions over server
 * messages, which is exactly the kind of code that stops matching without
 * anything saying so. These pin the cases that are worth explaining.
 */
describe('explaining a failed statement', () => {
  it('blames a trigger when the missing table is not in the statement', () => {
    const text = explainStatementError('relation "audit_log" does not exist', {
      sql: 'UPDATE users SET tier = 1',
      table: 'users',
    });
    assert.match(text, /never names audit_log/);
    assert.match(text, /trigger on users/);
    assert.match(text, /The server said: relation "audit_log" does not exist$/);
  });

  it('points at the selection when the missing table is in the statement', () => {
    const text = explainStatementError("Table 'shop.orders' doesn't exist", {
      sql: 'DELETE FROM orders',
      table: 'orders',
    });
    assert.match(text, /preview the whole file/);
  });

  it('does not match a table name inside a longer word', () => {
    const text = explainStatementError('relation "user" does not exist', {
      sql: 'UPDATE users SET x = 1',
      table: 'users',
    });
    assert.match(text, /never names user\b/);
  });

  it('turns permissions, timeouts and lock waits into what to do', () => {
    const context = { sql: 'ALTER TABLE users ADD x int', table: 'users' };
    assert.match(explainStatementError('permission denied for table users', context), /role Rehearsal connects as/);
    assert.match(explainStatementError('canceling statement due to statement timeout', context), /statementTimeoutMs/);
    assert.match(explainStatementError('canceling statement due to lock timeout', context), /another session is holding users/);
  });

  it('leaves anything it cannot be sure of exactly as the server said it', () => {
    assert.equal(explainStatementError('something odd', { sql: 'SELECT 1' }), 'something odd');
  });
});
