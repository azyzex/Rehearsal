import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { analyzeStatements } from '../analysis/orchestrator';
import { Finding } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Triggers, and the one place the rollback promise can stop holding.
 *
 * Everything this extension does rests on running inside a transaction that is
 * rolled back. A trigger that writes to another table is covered by that. A
 * trigger that sends a notification, reaches through a foreign data wrapper or
 * makes an HTTP call has already done something the rollback cannot recall —
 * and the preview will have caused it for real.
 */

describe('triggers', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let db: Client;

  before(async () => {
    fixture = await startPostgres();
    db = new Client({ connectionString: fixture.connectionString });
    await db.connect();

    await db.query(`
      CREATE TABLE accounts (id serial PRIMARY KEY, balance int NOT NULL, tier text);
      CREATE TABLE audit (id serial PRIMARY KEY, note text);

      INSERT INTO accounts (balance, tier)
      SELECT i, CASE WHEN i % 2 = 0 THEN 'free' ELSE 'pro' END
      FROM generate_series(1, 200) AS i;

      -- Contained: writes a row, which the rollback takes with it.
      CREATE FUNCTION log_change() RETURNS trigger AS $$
      BEGIN
        INSERT INTO audit (note) VALUES ('changed ' || NEW.id);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER accounts_audit
        AFTER UPDATE ON accounts
        FOR EACH ROW EXECUTE FUNCTION log_change();

      -- Not contained: the notification is the part a ROLLBACK cannot recall
      -- in the way people assume it can.
      CREATE FUNCTION announce() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('accounts', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER accounts_announce
        AFTER UPDATE ON accounts
        FOR EACH ROW EXECUTE FUNCTION announce();

      -- Fires on a different event, so an UPDATE must not list it.
      CREATE FUNCTION on_delete() RETURNS trigger AS $$
      BEGIN
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER accounts_on_delete
        BEFORE DELETE ON accounts
        FOR EACH ROW EXECUTE FUNCTION on_delete();

      -- Disabled, and therefore not something that fires.
      CREATE TRIGGER accounts_off
        AFTER UPDATE ON accounts
        FOR EACH ROW EXECUTE FUNCTION log_change();
      ALTER TABLE accounts DISABLE TRIGGER accounts_off;

      ANALYZE accounts, audit;
    `);

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

  describe('reading them', () => {
    it('finds every trigger on the table, with its timing and events', async () => {
      const triggers = await adapter.triggers('accounts');
      const byName = new Map(triggers.map((trigger) => [trigger.name, trigger]));

      assert.deepEqual(
        [...byName.keys()].sort(),
        ['accounts_announce', 'accounts_audit', 'accounts_off', 'accounts_on_delete'],
      );

      const audit = byName.get('accounts_audit')!;
      assert.equal(audit.timing, 'after');
      assert.deepEqual(audit.events, ['update']);
      assert.equal(audit.functionName, 'log_change');
      assert.equal(audit.enabled, true);

      const onDelete = byName.get('accounts_on_delete')!;
      assert.equal(onDelete.timing, 'before');
      assert.deepEqual(onDelete.events, ['delete']);
    });

    it('reports a disabled trigger as disabled rather than leaving it out', async () => {
      const off = (await adapter.triggers('accounts')).find(
        (trigger) => trigger.name === 'accounts_off',
      );
      assert.equal(off!.enabled, false);
    });

    it('says nothing about a table with no triggers', async () => {
      assert.deepEqual(await adapter.triggers('audit'), []);
    });

    it('does not report the internal triggers a foreign key creates', async () => {
      // Every foreign key installs a pair of them. Listing those would bury
      // the ones somebody wrote.
      await db.query(`
        CREATE TABLE holds (
          id         serial PRIMARY KEY,
          account_id int NOT NULL REFERENCES accounts (id)
        );
      `);
      assert.deepEqual(await adapter.triggers('holds'), []);
      await db.query('DROP TABLE holds');
    });
  });

  describe('what escapes a rollback', () => {
    it('flags the one that sends a notification', async () => {
      const announce = (await adapter.triggers('accounts')).find(
        (trigger) => trigger.name === 'accounts_announce',
      );
      assert.equal(announce!.escapes.length, 1);
      assert.match(announce!.escapes[0]!, /notification/);
    });

    it('leaves the one that only writes a row alone', async () => {
      const audit = (await adapter.triggers('accounts')).find(
        (trigger) => trigger.name === 'accounts_audit',
      );
      assert.deepEqual(audit!.escapes, [], 'the rollback takes that row with it');
    });

    it('recognises the other ways out', async () => {
      await db.query(`
        CREATE FUNCTION reaches_out() RETURNS trigger AS $$
        BEGIN
          PERFORM dblink_exec('dbname=other', 'INSERT INTO t VALUES (1)');
          PERFORM http_post('https://example.invalid/hook', '{}');
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER accounts_reach
          AFTER UPDATE ON accounts
          FOR EACH ROW EXECUTE FUNCTION reaches_out();
      `);

      const reach = (await adapter.triggers('accounts')).find(
        (trigger) => trigger.name === 'accounts_reach',
      );
      assert.equal(reach!.escapes.length, 2);
      assert.ok(reach!.escapes.some((escape) => /another database/.test(escape)));
      assert.ok(reach!.escapes.some((escape) => /HTTP/.test(escape)));

      await db.query('DROP TRIGGER accounts_reach ON accounts');
      await db.query('DROP FUNCTION reaches_out()');
    });
  });

  describe('in the preview', () => {
    async function findingsFor(sql: string): Promise<Finding[]> {
      const findings: Finding[] = [];
      await analyzeStatements({
        adapter,
        statements: [
          { index: 0, sql, startOffset: 0, endOffset: sql.length, startLine: 0, endLine: 0 },
        ],
        thresholds: {
          cautionRows: 100,
          destructiveRows: 1000,
          largeTable: 100_000,
          sampleSize: 5,
          explainAnalyze: false,
        },
        onFinding: (finding) => findings.push(finding),
      });
      return findings;
    }

    it('carries the triggers that fire for this statement', async () => {
      const [finding] = await findingsFor(`UPDATE accounts SET tier = 'pro' WHERE id < 20`);
      const names = (finding!.triggers ?? []).map((trigger) => trigger.name).sort();
      assert.deepEqual(names, ['accounts_announce', 'accounts_audit']);
    });

    it('leaves out the ones that fire on a different event', async () => {
      const [finding] = await findingsFor(`UPDATE accounts SET tier = 'pro' WHERE id < 20`);
      assert.equal(
        (finding!.triggers ?? []).some((trigger) => trigger.name === 'accounts_on_delete'),
        false,
      );
    });

    it('leaves out the disabled one', async () => {
      const [finding] = await findingsFor(`UPDATE accounts SET tier = 'pro' WHERE id < 20`);
      assert.equal(
        (finding!.triggers ?? []).some((trigger) => trigger.name === 'accounts_off'),
        false,
      );
    });

    it('says nothing about triggers for a statement that fires none', async () => {
      const [finding] = await findingsFor('CREATE INDEX ON accounts (tier)');
      assert.equal(finding!.triggers, undefined);
    });

    it('counts what the trigger did, and then rolls it back with everything else', async () => {
      const before = await db.query('SELECT COUNT(*)::int AS n FROM audit');
      await findingsFor(`UPDATE accounts SET tier = 'pro' WHERE id < 20`);
      const after = await db.query('SELECT COUNT(*)::int AS n FROM audit');

      assert.equal(
        after.rows[0].n,
        before.rows[0].n,
        'the trigger really inserted rows, and the rollback really took them back',
      );
    });
  });
});
