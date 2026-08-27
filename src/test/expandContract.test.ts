import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseAdapter } from '../adapters/types';
import { expandContractPlans, needsPlan, renderPlans } from '../edit/expandContract';
import { replacement } from '../panel/rewriteText';

/**
 * The change, spread across deploys, and the rewrite as it lands in the file.
 *
 * Both are text generators, so both are testable without a database — and both
 * produce text somebody is going to run, which is the reason to test them at
 * all. The plan is checked for the things that make it *safe* rather than for
 * its wording: that the steps are in an order where no step is incompatible
 * with the code beside it, that the backfill is batched, and that the trigger
 * does not outlive the column it was keeping in step.
 */

/** Enough adapter to be asked for a column's type. */
const adapter = {
  engine: 'postgres',
  tableColumns: async () => [
    { name: 'name', type: 'character varying(80)', nullable: true, isPrimaryKey: false },
    { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
  ],
} as unknown as DatabaseAdapter;

describe('expand and contract', () => {
  it('offers nothing for a change that is already safe in one step', async () => {
    const edits = [
      { kind: 'add_column' as const, table: 'users', column: 'x', type: 'text', nullable: true },
    ];

    assert.equal(needsPlan(edits), false);
    assert.deepEqual(await expandContractPlans(adapter, edits), []);
  });

  it('knows which changes cannot ship in one deploy', () => {
    assert.equal(needsPlan([{ kind: 'drop_column', table: 'users', column: 'x' }]), true);
    assert.equal(
      needsPlan([{ kind: 'rename_column', table: 'users', column: 'name', to: 'full_name' }]),
      true,
    );
    assert.equal(
      needsPlan([{ kind: 'set_nullability', table: 'users', column: 'x', nullable: true }]),
      false,
      'relaxing a constraint breaks nothing',
    );
  });

  /**
   * The rename, which is the change people most often do in one step.
   *
   * The order is the whole feature: the new column and the trigger go out
   * together, the backfill follows, the readers move only once both columns
   * agree, and the old column goes last.
   */
  it('writes a rename out in an order with no incompatible gap', async () => {
    const [plan] = await expandContractPlans(adapter, [
      { kind: 'rename_column', table: 'users', column: 'name', to: 'full_name' },
    ]);

    assert.ok(plan);
    const sql = plan.steps.flatMap((step) => step.statements).join('\n');

    // The new column takes the old one's real type, read from the database
    // rather than guessed — that is the reason this runs against a connection.
    assert.match(sql, /ADD COLUMN "full_name" character varying\(80\)/);

    // The backfill is batched. A single UPDATE over the whole table holds a row
    // lock on every row it has touched, which is the outage this avoids.
    assert.match(sql, /LIMIT 5000/);

    // The trigger is dropped in the same step as the column it was syncing.
    const contract = plan.steps[plan.steps.length - 1]!;
    assert.match(contract.statements.join('\n'), /DROP TRIGGER/);
    assert.match(contract.statements.join('\n'), /DROP COLUMN "name"/);

    // Moving the readers is a deploy of its own, and is not SQL.
    const readers = plan.steps.find((step) => step.code?.includes('read'));
    assert.ok(readers, 'no step moves the readers');
    assert.deepEqual(readers.statements, []);

    // Deploy numbers only ever go forward.
    const deploys = plan.steps.map((step) => step.deploy);
    assert.deepEqual(deploys, [...deploys].sort((a, b) => a - b));
  });

  /**
   * `OLD` does not exist in a BEFORE INSERT trigger — referring to it there is
   * an error, not a null. A dual-write trigger that throws on every insert is
   * worse than no plan at all.
   */
  it('writes a trigger that survives an INSERT', async () => {
    const [plan] = await expandContractPlans(adapter, [
      { kind: 'rename_column', table: 'users', column: 'name', to: 'full_name' },
    ]);

    const body = plan!.steps.flatMap((step) => step.statements).find((sql) => sql.includes('$$'));
    assert.ok(body);
    assert.match(body, /TG_OP = 'INSERT'/);
  });

  it('makes the dropped column optional before dropping it', async () => {
    const [plan] = await expandContractPlans(adapter, [
      { kind: 'drop_column', table: 'users', column: 'nickname' },
    ]);

    const steps = plan!.steps.map((step) => step.statements.join(' '));
    const optional = steps.findIndex((sql) => sql.includes('DROP NOT NULL'));
    const dropped = steps.findIndex((sql) => sql.includes('DROP COLUMN'));

    assert.ok(optional >= 0 && dropped >= 0);
    assert.ok(optional < dropped, 'the column is dropped before it is made optional');
    assert.ok(plan!.steps[0]!.code, 'the first step is a code change, not SQL');
  });

  it('puts the writers before the backfill when making a column required', async () => {
    const [plan] = await expandContractPlans(adapter, [
      { kind: 'set_nullability', table: 'users', column: 'email', nullable: false },
    ]);

    // Backfilling first and stopping the writers later means the gap between
    // them fills up with new null rows.
    assert.ok(plan!.steps[0]!.code?.includes('required'));
    assert.match(plan!.steps[1]!.statements.join(' '), /IS NULL/);
    assert.match(plan!.steps[2]!.statements.join(' '), /NOT VALID/);
  });

  it('renders a file that says which steps must not ship together', async () => {
    const plans = await expandContractPlans(adapter, [
      { kind: 'drop_column', table: 'users', column: 'nickname' },
    ]);
    const file = renderPlans(plans);

    assert.match(file, /MUST NOT/);
    assert.match(file, /Deploy 1 — step 1 of 3/);
    assert.match(file, /NO SQL\./);
    // Every statement ends in a semicolon, because this is a file people run.
    assert.match(file, /DROP COLUMN "nickname";/);
  });
});

describe('a rewrite, as it lands in the file', () => {
  const rewrite = {
    title: 'Build it without locking',
    rationale: 'A plain CREATE INDEX holds a lock that blocks every write for the whole build.',
    statements: ['CREATE INDEX CONCURRENTLY a ON b (c)'],
    needsSeparateTransactions: true,
  };

  it('carries its reasoning into the file as a comment', () => {
    const text = replacement(rewrite, '');

    assert.match(text, /^-- A plain CREATE INDEX/);
    assert.match(text, /CREATE INDEX CONCURRENTLY a ON b \(c\)$/);
    // No trailing semicolon: the range being replaced stops before the file's
    // own, so adding one here would leave two.
    assert.doesNotMatch(text, /;\s*$/);
  });

  it('says out loud when the replacement cannot share a transaction', () => {
    assert.match(replacement(rewrite, ''), /must not share a transaction/);
  });

  it('keeps the statement indented where the original was, but not the first line', () => {
    const text = replacement({ ...rewrite, statements: ['ONE', 'TWO'] }, '    ');
    const lines = text.split('\n');

    assert.ok(!lines[0]!.startsWith(' '), 'the range already starts past the indentation');
    assert.ok(lines.some((line) => line === '    ONE;'));
    assert.ok(lines.some((line) => line === '    TWO'));
  });
});
