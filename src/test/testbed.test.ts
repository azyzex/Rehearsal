import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { PostgresAdapter } from '../adapters/postgres';
import { analyzeStatements } from '../analysis/orchestrator';
import { DEFAULT_THRESHOLDS, Finding, Severity } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { splitStatements } from '../parser/splitter';
import { PostgresFixture, startPostgres } from './support/pgFixture';

const run = promisify(execFile);

const ROOT = path.resolve(__dirname, '..', '..');
const SHOP = path.join(ROOT, 'testbed', 'postgres-shop');

/**
 * End-to-end over the testbed.
 *
 * This runs the real seeder script against a throwaway Postgres and then puts
 * the real migration files through the analyzer. It is the acceptance check for
 * spec §14 M2 — the four-row panel from §9 must come out red, red, amber,
 * green — and it doubles as a test of the testbed itself, so a broken seeder is
 * caught here rather than after someone has pointed it at a cloud database.
 *
 * Scaled down (2,000 users rather than 50,000) to keep the suite quick. The
 * severities are the same; only the numbers shrink.
 */

const USERS = 2000;
const ORDERS = 5000;

describe('testbed end to end', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;

  before(async () => {
    fixture = await startPostgres();

    const { stdout } = await run(
      process.execPath,
      [
        path.join(SHOP, 'scripts', 'setup.mjs'),
        '--url',
        fixture.connectionString,
        '--users',
        String(USERS),
        '--orders',
        String(ORDERS),
      ],
      { cwd: ROOT },
    );
    assert.match(stdout, /Seeded\./, stdout);

    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await adapter?.dispose();
    await fixture?.stop();
  });

  const analyzeFile = async (name: string): Promise<Finding[]> => {
    const sql = fs.readFileSync(path.join(SHOP, 'migrations', name), 'utf8');
    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: splitStatements(sql),
      thresholds: DEFAULT_THRESHOLDS,
      onFinding: (finding) => findings.push(finding),
    });
    return findings;
  };

  const severities = (findings: readonly Finding[]): Severity[] =>
    findings.map((finding) => finding.severity);

  it('renders the demo file as red, red, amber, green', async () => {
    const findings = await analyzeFile('0007_update.sql');

    assert.deepEqual(severities(findings), ['destructive', 'blocking', 'caution', 'safe']);

    assert.match(findings[0]!.detail, /rows have a value in phone_number/);
    assert.match(findings[1]!.detail, /12 rows have no email/);
    assert.match(findings[2]!.detail, /Writes are blocked for roughly/);
    assert.equal(findings[2]!.estimated, true);
    assert.equal(findings[3]!.headline, 'Safe');
  });

  it('reports the all-safe file with no hedging', async () => {
    const findings = await analyzeFile('0009_safe_changes.sql');
    assert.deepEqual(severities(findings), ['safe', 'safe', 'safe', 'safe']);
    assert.match(findings[0]!.detail, /nickname is empty in all/);
  });

  it('flags every constraint in the constraints file, with counts', async () => {
    const findings = await analyzeFile('0006_add_constraints.sql');
    assert.deepEqual(severities(findings), ['blocking', 'blocking', 'blocking', 'blocking']);

    assert.match(findings[0]!.detail, /200 rows in users reference org_id values that are not in orgs/);
    assert.match(findings[1]!.detail, /150 rows in orders reference user_id values that are not in users/);
    assert.match(findings[2]!.detail, /40 rows share a duplicate email/);
    assert.ok(findings[3]!.rowCount! > 0, 'zero-total refunds violate the CHECK');
  });

  it('separates a scoped DELETE from an unscoped one', async () => {
    const findings = await analyzeFile('0008_cleanup_carts.sql');

    assert.equal(findings[0]!.severity, 'destructive');
    assert.match(findings[0]!.detail, /There is no WHERE clause/);

    assert.equal(findings[2]!.severity, 'safe');
    assert.match(findings[2]!.detail, /matches no rows/);

    // The last statement targets a table that only exists after 0001 is
    // applied for real, so this row is expected to fail on its own.
    assert.equal(findings[3]!.headline, "Couldn't analyze");
    assert.match(findings[3]!.detail, /previews never commit/);
  });

  it('catches the WHERE clause that only looks scoped', async () => {
    const findings = await analyzeFile('0005_retire_free_tier.sql');

    // `WHERE tier IS NOT NULL` on a NOT NULL column is every row.
    const last = findings[2]!;
    assert.equal(last.rowCount, USERS);
    assert.equal(last.severity, 'destructive');
  });

  it('splits the torture fixture into exactly nine statements', async () => {
    const sql = fs.readFileSync(path.join(SHOP, 'migrations', 'parser_torture.sql'), 'utf8');
    assert.equal(splitStatements(sql).length, 9);
  });

  it('leaves the seeded data untouched after all of that', async () => {
    const users = await adapter.countRows('users');
    const orders = await adapter.countRows('orders');
    const phones = await adapter.countNonNull('users', 'phone_number');

    assert.equal(users, USERS);
    assert.equal(orders, ORDERS);
    assert.ok(phones > 0 && phones < USERS);
  });
});
