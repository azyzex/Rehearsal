import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { cascadeTables, cascadeTotal, describeCascade, nulledTables } from '../analysis/cascade';
import { analyzeStatements } from '../analysis/orchestrator';
import { DEFAULT_THRESHOLDS, Finding } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { splitStatements } from '../parser/splitter';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Cascades.
 *
 * `DELETE FROM users WHERE id = 5` is one row in the statement text and an
 * unknown number of rows in the database. The count is invisible in the SQL,
 * invisible in the schema diagram, and obtainable only by walking the foreign
 * keys against the real data.
 */

describe('reading a cascade tree', () => {
  const tree = {
    table: 'users',
    rows: 1,
    children: [
      {
        table: 'orders',
        rows: 12,
        via: { constraint: 'orders_user_fkey', action: 'cascade' as const },
        children: [
          {
            table: 'order_items',
            rows: 34,
            via: { constraint: 'items_order_fkey', action: 'cascade' as const },
            children: [],
          },
        ],
      },
      {
        table: 'reviews',
        rows: 3,
        via: { constraint: 'reviews_user_fkey', action: 'set null' as const },
        children: [],
      },
    ],
  };

  it('counts every level below the root, not the root itself', () => {
    // The row the statement names is already reported; the surprise is
    // everything under it.
    assert.equal(cascadeTotal(tree), 12 + 34 + 3);
  });

  it('lists the tables it reaches, in the order it reaches them', () => {
    assert.deepEqual(cascadeTables(tree), ['orders', 'order_items', 'reviews']);
  });

  it('separates rows that are blanked from rows that are removed', () => {
    // SET NULL is the quieter surprise: nothing is deleted and a column full
    // of references silently becomes null.
    assert.deepEqual(nulledTables(tree).map((n) => n.table), ['reviews']);
  });

  it('leads with the total, because that is the number nobody expects', () => {
    // 46, not 49. The three rows in `reviews` have their reference set to
    // null and are not deleted — counting them in the same total *and* then
    // listing them separately as not deleted said two different things about
    // the same three rows.
    const text = describeCascade(tree);
    assert.match(text, /cascades to 46 rows across 2 other tables/);
    assert.match(text, /12 in orders/);
    assert.match(text, /34 in order_items/);
    assert.doesNotMatch(text, /reviews.*cascades|cascades.*3 in reviews/);
    assert.match(text, /set to null rather than being deleted/);
  });

  it('says a reference that refuses the delete refuses it, rather than cascading', () => {
    // RESTRICT and NO ACTION do not cascade and do not blank anything: they
    // make the statement fail. Counting them as "rows this also deletes" was
    // wrong about what happens and reassuring about a delete that will error.
    const text = describeCascade({
      table: 'users',
      rows: 1,
      children: [
        { table: 'invoices', rows: 7, via: { constraint: 'i_fk', action: 'restrict' }, children: [] },
      ],
    });

    assert.doesNotMatch(text, /cascades to/);
    assert.match(text, /7 rows in invoices/);
    assert.match(text, /still reference these/);
    assert.match(text, /does not cascade, so the delete is refused/);
  });

  it("uses the engine's own explanation when it has one", () => {
    // MongoDB has no cascade at all, and says on the node what really happens:
    // the documents are left pointing at something that is gone.
    const text = describeCascade({
      table: 'users',
      rows: 1,
      children: [
        {
          table: 'orders',
          rows: 40,
          via: { constraint: 'inferred', action: 'no action' },
          children: [],
          truncated: 'MongoDB does not cascade. These documents are left orphaned.',
        },
      ],
    });

    assert.match(text, /MongoDB does not cascade/);
    assert.match(text, /left orphaned/);
    assert.doesNotMatch(text, /cascades to/);
  });

  it('says nothing at all when there is no cascade', () => {
    assert.equal(describeCascade({ table: 'users', rows: 5, children: [] }), '');
    assert.equal(describeCascade(undefined), '');
  });

  it('admits when the walk stopped early', () => {
    const text = describeCascade({
      table: 'users',
      rows: 1,
      children: [{ table: 'a', rows: 2, via: { constraint: 'x', action: 'cascade' }, children: [] }],
      truncated: 'stopped after 25 related tables',
    });
    assert.match(text, /the real total may be higher/);
  });
});

describe('walking a real cascade', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;

  before(async () => {
    fixture = await startPostgres();
    verifier = new Client({ connectionString: fixture.connectionString });
    await verifier.connect();

    // A chain three deep, with a SET NULL branch — the shape that makes
    // cascades surprising.
    await verifier.query(`
      ALTER TABLE users ADD CONSTRAINT users_org_fkey
        FOREIGN KEY (org_id) REFERENCES orgs (id) NOT VALID;

      CREATE TABLE accounts (
        id      serial PRIMARY KEY,
        user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE
      );
      CREATE TABLE transactions (
        id         serial PRIMARY KEY,
        account_id integer NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        cents      integer NOT NULL
      );
      CREATE TABLE audit_entries (
        id      serial PRIMARY KEY,
        user_id integer REFERENCES users (id) ON DELETE SET NULL,
        note    text
      );

      INSERT INTO accounts (user_id) SELECT id FROM users WHERE id <= 10;
      INSERT INTO transactions (account_id, cents)
        SELECT a.id, 100 FROM accounts a, generate_series(1, 3);
      INSERT INTO audit_entries (user_id, note)
        SELECT id, 'note' FROM users WHERE id <= 10;

      ANALYZE;
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
    await verifier?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  it('counts through several levels', async () => {
    const tree = await adapter.cascadeImpact('users', 'id = 1', []);

    assert.equal(tree.rows, 1, 'the statement itself takes one row');

    const accounts = tree.children.find((c) => c.table === 'accounts')!;
    assert.equal(accounts.rows, 1);
    assert.equal(accounts.via?.action, 'cascade');

    const transactions = accounts.children.find((c) => c.table === 'transactions')!;
    assert.equal(transactions.rows, 3, 'the level the statement is two removes from');
  });

  it('reports a SET NULL branch as blanked rather than deleted', async () => {
    const tree = await adapter.cascadeImpact('users', 'id = 1', []);
    const audit = tree.children.find((c) => c.table === 'audit_entries')!;

    assert.equal(audit.rows, 1);
    assert.equal(audit.via?.action, 'set null');
    assert.deepEqual(audit.children, [], 'a blanked row cascades no further');
  });

  it('scales to a predicate matching many rows', async () => {
    const tree = await adapter.cascadeImpact('users', 'id <= 10', []);
    assert.equal(tree.rows, 10);
    assert.equal(tree.children.find((c) => c.table === 'accounts')!.rows, 10);
    assert.equal(cascadeTotal(tree), 10 + 30 + 10);
  });

  it('finds nothing when the rows have no dependents', async () => {
    const tree = await adapter.cascadeImpact('users', 'id = 99', []);
    assert.deepEqual(tree.children, []);
    assert.equal(cascadeTotal(tree), 0);
  });

  it('counts nothing at all for a table nothing references', async () => {
    const tree = await adapter.cascadeImpact('transactions', 'id = 1', []);
    assert.deepEqual(tree.children, []);
  });

  it('never changes anything while counting', async () => {
    await adapter.cascadeImpact('users', 'true', []);

    const { rows } = await verifier.query(
      `SELECT (SELECT COUNT(*) FROM users)::int AS users,
              (SELECT COUNT(*) FROM accounts)::int AS accounts,
              (SELECT COUNT(*) FROM transactions)::int AS transactions`,
    );
    assert.deepEqual({ ...rows[0] }, { users: 100, accounts: 10, transactions: 30 });
  });

  describe('through the analyzer', () => {
    const analyse = async (sql: string): Promise<Finding> => {
      const findings: Finding[] = [];
      await analyzeStatements({
        adapter,
        statements: splitStatements(sql),
        thresholds: DEFAULT_THRESHOLDS,
        onFinding: (finding) => findings.push(finding),
      });
      return findings[0]!;
    };

    it('puts the cascade in the sentence, and makes the row destructive', async () => {
      const finding = await analyse('DELETE FROM users WHERE id = 1');

      assert.equal(finding.rowCount, 1);
      assert.match(finding.detail, /1 row is deleted from users/);
      // Four, not five: the fifth is in audit_entries and has its reference set
      // to null rather than being deleted, which the next line says separately.
      assert.match(finding.detail, /cascades to 4 rows across 2 other tables/);
      assert.match(finding.detail, /audit_entries/);
      assert.match(finding.detail, /set to null rather than being deleted/);
      assert.equal(
        finding.severity,
        'destructive',
        'one row named, five more taken — that is not a safe statement',
      );
    });

    it('says nothing extra when a delete cascades to nothing', async () => {
      const finding = await analyse('DELETE FROM transactions WHERE id = 1');
      assert.equal(finding.cascade?.children.length, 0);
      assert.doesNotMatch(finding.detail, /cascades/);
    });

    it('handles a delete with no WHERE clause', async () => {
      const finding = await analyse('DELETE FROM accounts');
      assert.match(finding.detail, /There is no WHERE clause/);
      assert.match(finding.detail, /cascades to 30 rows/);
    });

    it('declines rather than guessing on a shape it cannot read', async () => {
      // A USING clause means the predicate cannot be lifted out on its own,
      // and a cascade count from the wrong predicate would be confidently
      // wrong — worse than absent.
      const finding = await analyse(
        `DELETE FROM accounts USING users WHERE accounts.user_id = users.id AND users.tier = 'pro'`,
      );
      assert.equal(finding.cascade, undefined);
      assert.ok(finding.rowCount! > 0, 'the count itself is still measured');
    });

    it('counts a cascade for a statement carrying bound parameters', async () => {
      // The visual editor generates `WHERE "id" = $1`. A counter that could
      // not take parameters would fail on exactly the statements the tool
      // itself produces.
      const findings: Finding[] = [];
      await analyzeStatements({
        adapter,
        thresholds: DEFAULT_THRESHOLDS,
        statements: [
          {
            index: 0,
            sql: 'DELETE FROM users WHERE "id" = $1',
            params: [2],
            startOffset: 0,
            endOffset: 0,
            startLine: 0,
            endLine: 0,
          },
        ],
        onFinding: (finding) => findings.push(finding),
      });

      const finding = findings[0]!;
      assert.equal(finding.error, undefined);
      assert.equal(finding.rowCount, 1);
      assert.equal(finding.cascade?.children.find((c) => c.table === 'accounts')?.rows, 1);
      assert.match(finding.detail, /cascades to/);
    });

    it('leaves the data alone through all of it', async () => {
      const { rows } = await verifier.query(`SELECT COUNT(*)::int AS n FROM transactions`);
      assert.equal(Number(rows[0].n), 30);
    });
  });
});
