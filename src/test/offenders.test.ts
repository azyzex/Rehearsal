import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { findOffenders } from '../analysis/offenders';
import { classify } from '../parser/classifier';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The rows behind the count.
 *
 * "12 rows have no email" is where every other tool stops, and it is where the
 * work starts. These tests are mostly about the generated fixes: they have to
 * be real SQL that runs and actually resolves the blocker, or the feature is
 * worse than not having it.
 */

describe('offenders', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;
  let verifier: Client;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
    verifier = new Client({ connectionString: fixture.connectionString });
    await verifier.connect();
  });

  after(async () => {
    await verifier?.end().catch(() => undefined);
    await adapter?.dispose();
    await fixture?.stop();
  });

  const find = (sql: string, limit = 25) => findOffenders(adapter, classify(sql), limit);

  describe('finding them', () => {
    it('finds the rows that block a NOT NULL', async () => {
      const found = (await find('ALTER TABLE users ALTER COLUMN email SET NOT NULL'))!;

      assert.equal(found.kind, 'null');
      assert.equal(found.total, 12);
      assert.equal(found.rows.length, 12);
      for (const row of found.rows) {
        assert.equal(row['email'], null, 'every row shown really is one of the twelve');
      }
    });

    it('finds the orphans that block a foreign key', async () => {
      const found = (await find(
        'ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)',
      ))!;

      assert.equal(found.kind, 'orphan');
      assert.equal(found.total, 10);
      for (const row of found.rows) {
        assert.equal(row['org_id'], 99, 'the org that does not exist');
      }
    });

    it('finds duplicates with their group members together', async () => {
      // Ordered by the duplicated column, because scattered rows make the
      // duplication invisible in a sample.
      const found = (await find('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)'))!;

      assert.equal(found.kind, 'duplicate');
      assert.equal(found.total, 8);
      assert.deepEqual(
        [...new Set(found.rows.map((r) => r['email']))],
        ['dupe@example.com'],
        'one group, shown together',
      );
    });

    it('finds the rows that violate a check', async () => {
      const found = (await find(
        'ALTER TABLE users ADD CONSTRAINT tier_len CHECK (length(tier) > 4)',
      ))!;

      assert.equal(found.kind, 'violation');
      assert.ok(found.total > 0);
      for (const row of found.rows) {
        assert.ok(String(row['tier']).length <= 4, 'each shown row really violates it');
      }
    });

    it('shows what a DROP COLUMN is about to empty', async () => {
      const found = (await find('ALTER TABLE users DROP COLUMN phone_number'))!;
      assert.equal(found.total, 50);
      for (const row of found.rows) {
        assert.notEqual(row['phone_number'], null);
      }
    });

    it('caps what it fetches', async () => {
      const found = (await find('ALTER TABLE users DROP COLUMN phone_number', 5))!;
      assert.equal(found.rows.length, 5);
      assert.equal(found.total, 50, 'but still reports the true total');
    });

    it('declines for statements with no offending rows to show', async () => {
      assert.equal(await find('DROP TABLE users'), undefined);
      assert.equal(await find(`UPDATE users SET tier = 'free'`), undefined);
      assert.equal(await find('CREATE INDEX i ON users (tier)'), undefined);
    });

    it('finds nothing when nothing is wrong', async () => {
      const found = (await find('ALTER TABLE users ALTER COLUMN tier SET NOT NULL'))!;
      assert.equal(found.total, 0);
      assert.deepEqual(found.rows, []);
    });
  });

  describe('rowsMatching', () => {
    it('is bounded even against a predicate matching everything', async () => {
      const rows = await adapter.rowsMatching('users', 'true', 3);
      assert.equal(rows.length, 3);
    });

    it('orders when asked, so groups stay together', async () => {
      const rows = await adapter.rowsMatching('users', 'true', 5, '"id" DESC');
      const ids = rows.map((r) => Number(r['id']));
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    });
  });
  describe('the generated fixes actually resolve the blocker', () => {
    /**
     * Each of these applies the fix and then asserts the original statement
     * would now succeed. A fix that runs but does not unblock anything is a
     * more expensive way of doing nothing.
     */

    it('the backfill clears the nulls', async () => {
      const found = (await find('ALTER TABLE users ALTER COLUMN email SET NOT NULL'))!;
      assert.equal(found.fix!.needsEditing, true, 'it has a placeholder in it');

      // Standing in for the human decision the placeholder represents.
      await verifier.query(found.fix!.sql.replace('/* the right value */', `'filled-' || id`));

      await verifier.query('ALTER TABLE users ALTER COLUMN email SET NOT NULL');
      const { rows } = await verifier.query(
        `SELECT attnotnull FROM pg_attribute
          WHERE attrelid = 'users'::regclass AND attname = 'email'`,
      );
      assert.equal(rows[0].attnotnull, true);

      await verifier.query('ALTER TABLE users ALTER COLUMN email DROP NOT NULL');
    });

    it('detaching the orphans lets the foreign key be added', async () => {
      const found = (await find(
        'ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)',
      ))!;
      assert.equal(found.fix!.needsEditing, false, 'nothing to decide, so nothing to fill in');

      await verifier.query(found.fix!.sql);
      await verifier.query(
        'ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)',
      );

      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'users_org_fkey'`,
      );
      assert.equal(Number(rows[0].n), 1);
      await verifier.query('ALTER TABLE users DROP CONSTRAINT users_org_fkey');
    });

    it('deduplicating lets the unique constraint be added', async () => {
      const found = (await find('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)'))!;
      await verifier.query(found.fix!.sql);

      await verifier.query('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)');
      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'users_email_key'`,
      );
      assert.equal(Number(rows[0].n), 1);
      await verifier.query('ALTER TABLE users DROP CONSTRAINT users_email_key');
    });

    it('keeps one row of each duplicate group rather than deleting all of them', async () => {
      // The obvious wrong implementation deletes every member of the group,
      // which satisfies the constraint and loses the data.
      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE email = 'dupe@example.com'`,
      );
      assert.equal(Number(rows[0].n), 1, 'one survivor from the group of eight');
    });

    it('deleting the violations lets the check be added', async () => {
      const found = (await find(
        'ALTER TABLE users ADD CONSTRAINT tier_len CHECK (length(tier) > 4)',
      ))!;
      await verifier.query(found.fix!.sql);
      await verifier.query('ALTER TABLE users ADD CONSTRAINT tier_len CHECK (length(tier) > 4)');

      const { rows } = await verifier.query(
        `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'tier_len'`,
      );
      assert.equal(Number(rows[0].n), 1);

      // And this is exactly why the note calls deleting the blunt option: no
      // tier in this table is longer than four characters, so satisfying the
      // constraint meant removing every row. The fix did what it said and the
      // result is almost certainly not what anyone wanted.
      const left = await verifier.query('SELECT COUNT(*)::int AS n FROM users');
      assert.equal(Number(left.rows[0].n), 0, 'the whole table, gone');
    });

    it('says plainly when deleting is the blunt option', async () => {
      const found = (await find(
        'ALTER TABLE users ADD CONSTRAINT c CHECK (length(tier) > 99)',
      ))!;
      assert.match(found.fix!.note, /blunt option and usually the wrong one/);
    });
  });

});
