import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PostgresAdapter } from '../adapters/postgres';
import { analysePlan, parsePlan } from '../analysis/plan';
import { APPLICATION_NAME } from '../constants';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * Query plans.
 *
 * Two halves: parsing what Postgres emits, which has to survive fields being
 * absent, and deciding what is worth saying about it — which is mostly about
 * not saying the obvious wrong thing. A sequential scan is the right choice on
 * a small table, and calling it a problem there is the cargo-cult version of
 * the advice.
 */

const node = (over: Record<string, unknown> = {}) => ({
  'Node Type': 'Seq Scan',
  'Relation Name': 'users',
  'Actual Total Time': 10,
  'Actual Rows': 100,
  'Plan Rows': 100,
  'Actual Loops': 1,
  ...over,
});

describe('parsePlan', () => {
  it('reads the array-wrapped shape EXPLAIN returns', () => {
    const parsed = parsePlan([{ Plan: node() }])!;
    assert.equal(parsed.kind, 'Seq Scan');
    assert.equal(parsed.relation, 'users');
    assert.equal(parsed.totalMs, 10);
  });

  it('multiplies per-loop timings by the loop count', () => {
    // Actual Total Time is per loop. A node inside a nested loop that ran 500
    // times is 500x the cost it appears to be, and those are exactly the nodes
    // most likely to be the problem.
    const parsed = parsePlan([
      { Plan: node({ 'Actual Total Time': 2, 'Actual Loops': 500, 'Actual Rows': 3 }) },
    ])!;
    assert.equal(parsed.totalMs, 1000);
    assert.equal(parsed.actualRows, 1500);
  });

  it('subtracts children to get the time a node spent on its own', () => {
    const parsed = parsePlan([
      {
        Plan: node({
          'Node Type': 'Hash Join',
          'Actual Total Time': 100,
          Plans: [node({ 'Actual Total Time': 70 }), node({ 'Actual Total Time': 20 })],
        }),
      },
    ])!;

    assert.equal(parsed.totalMs, 100);
    assert.equal(parsed.selfMs, 10, 'its own work, not its children"s');
    assert.equal(parsed.children.length, 2);
  });

  it('treats a missing field as zero rather than throwing', () => {
    // A plan without ANALYZE has no actual times at all, and a crash here would
    // take the whole preview with it.
    const parsed = parsePlan([{ Plan: { 'Node Type': 'Seq Scan' } }])!;
    assert.equal(parsed.totalMs, 0);
    assert.equal(parsed.actualRows, 0);
    assert.equal(parsed.relation, undefined);
  });

  it('returns nothing for something that is not a plan', () => {
    assert.equal(parsePlan(undefined), undefined);
    assert.equal(parsePlan([]), undefined);
    assert.equal(parsePlan([{}]), undefined);
  });
});

describe('analysePlan', () => {
  const analyse = (plan: unknown) => analysePlan(parsePlan(plan)!);

  it('says nothing about a sequential scan on a small table', () => {
    // It is the right choice there, and warning about it would train people to
    // ignore the warnings.
    const result = analyse([{ Plan: node({ 'Actual Rows': 500 }) }]);
    assert.equal(result.insights.some((i) => i.kind === 'sequential-scan'), false);
  });

  it('flags a sequential scan on a large one', () => {
    const result = analyse([{ Plan: node({ 'Actual Rows': 500_000, 'Plan Rows': 500_000 }) }]);
    const insight = result.insights.find((i) => i.kind === 'sequential-scan')!;
    assert.match(insight.message, /reads 500,000 rows sequentially/);
    assert.match(insight.message, /An index on the filtered columns/);
  });

  it('flags an estimate that is badly wrong in either direction', () => {
    const under = analyse([{ Plan: node({ 'Actual Rows': 10_000, 'Plan Rows': 100 }) }]);
    assert.ok(under.insights.some((i) => i.kind === 'bad-estimate'));

    const over = analyse([{ Plan: node({ 'Actual Rows': 100, 'Plan Rows': 10_000 }) }]);
    assert.ok(over.insights.some((i) => i.kind === 'bad-estimate'));

    const fine = analyse([{ Plan: node({ 'Actual Rows': 110, 'Plan Rows': 100 }) }]);
    assert.equal(fine.insights.some((i) => i.kind === 'bad-estimate'), false);
  });

  it('names the node that took the time', () => {
    const result = analyse([
      {
        Plan: node({
          'Node Type': 'Hash Join',
          'Relation Name': undefined,
          'Actual Total Time': 100,
          Plans: [
            node({ 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Actual Total Time': 5 }),
          ],
        }),
      },
    ]);

    const insight = result.insights.find((i) => i.kind === 'most-expensive')!;
    assert.match(insight.message, /Hash Join is 95% of the total time/);
  });

  it('does not name a most-expensive node when the time is spread evenly', () => {
    // Six children at 15% each. Naming one of them would be pointing at
    // nothing — there is no hot spot, and saying there is would be worse than
    // saying nothing.
    const result = analyse([
      {
        Plan: node({
          'Node Type': 'Append',
          'Actual Total Time': 100,
          Plans: Array.from({ length: 6 }, () => node({ 'Actual Total Time': 15 })),
        }),
      },
    ]);
    assert.equal(result.insights.some((i) => i.kind === 'most-expensive'), false);
  });

  it('names it when one node really does dominate', () => {
    const result = analyse([
      {
        Plan: node({
          'Node Type': 'Append',
          'Actual Total Time': 100,
          Plans: [node({ 'Actual Total Time': 80 }), node({ 'Actual Total Time': 10 })],
        }),
      },
    ]);
    assert.match(
      result.insights.find((i) => i.kind === 'most-expensive')!.message,
      /80% of the total time/,
    );
  });
});

describe('against a real plan', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 2000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await adapter?.dispose();
    await fixture?.stop();
  });

  it('parses what Postgres actually emits', async () => {
    const plan = await adapter.explain(`SELECT * FROM users WHERE tier = 'pro'`, false);
    const parsed = parsePlan(plan.raw)!;

    assert.ok(parsed, 'the real shape parses');
    assert.ok(parsed.kind.length > 0);
    assert.equal(parsed.estimatedRows > 0, true, 'the planner estimated something');
  });

  it('parses a plan with joins and children', async () => {
    const plan = await adapter.explain(
      `SELECT * FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.tier = 'pro'`,
      false,
    );
    const parsed = parsePlan(plan.raw)!;
    assert.ok(parsed.children.length > 0, 'the tree has depth');
  });
});
