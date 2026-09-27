import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PostgresAdapter } from '../adapters/postgres';
import { columnSections, findColumnOpportunities } from '../analysis/columnFindings';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * What the data says about its own columns, against a real Postgres.
 *
 * The fixture was seeded for other reasons, and that is useful here: nobody
 * arranged these answers. `nickname` is never set by the seed, and `org_id`
 * is nullable but filled on every row.
 */
describe('what the data already says about its columns', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 5000,
      applicationName: 'vscode-rehearsal',
    });
  });

  after(async () => {
    await adapter.dispose().catch(() => undefined);
    await fixture.stop();
  });

  it('finds the column nothing fills in, and the nullable one that is never null', async () => {
    const statistics = await adapter.columnStatistics();
    const snapshot = await adapter.schemaSnapshot();
    const rows = new Map(snapshot.tables.map((table) => [table.qualified, table.rows]));

    const findings = await findColumnOpportunities(adapter, statistics, rows);

    assert.ok(
      findings.neverFilled.some((entry) => entry.table === 'users' && entry.column === 'nickname'),
      `never filled: ${JSON.stringify(findings.neverFilled)}`,
    );
    assert.ok(
      findings.couldRequire.some((entry) => entry.table === 'users' && entry.column === 'org_id'),
      `could require: ${JSON.stringify(findings.couldRequire)}`,
    );

    // email has twelve nulls and eight duplicates, so it must appear in
    // neither list: the statistics are a sample, the report is a count.
    assert.ok(!findings.couldRequire.some((entry) => entry.column === 'email'));
    assert.ok(!findings.uniqueInPractice.some((entry) => entry.column === 'email'));
    // And the primary key is already unique, so it is not suggested.
    assert.ok(!findings.uniqueInPractice.some((entry) => entry.column === 'id'));
  });

  it('writes sections that say how the workspace search came out', async () => {
    const lines = columnSections(
      {
        neverFilled: [{ table: 'users', column: 'nickname', rows: 100 }],
        couldRequire: [],
        uniqueInPractice: [],
        fewValues: [],
      },
      new Map([['users.nickname', 0]]),
    ).join('\n');

    assert.match(lines, /Columns nothing has ever filled in/);
    assert.match(lines, /\| `users\.nickname` \| 100 \| \*\*none\*\* \|/);
  });
});
