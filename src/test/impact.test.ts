import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PostgresAdapter } from '../adapters/postgres';
import { buildDiagram, Diagram } from '../analysis/impact';
import { analyzeStatements } from '../analysis/orchestrator';
import { DEFAULT_THRESHOLDS, Finding } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { splitStatements } from '../parser/splitter';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The impact diagram.
 *
 * A schema diagram shows the same picture whatever you are about to run. These
 * tests are about the difference: the diagram must contain only the tables the
 * file touches, and each one must carry what this file does to it.
 */

describe('impact diagram', () => {
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

  const diagramFor = async (sql: string): Promise<Diagram> => {
    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: splitStatements(sql),
      thresholds: DEFAULT_THRESHOLDS,
      onFinding: (finding) => findings.push(finding),
    });
    return buildDiagram(adapter, findings);
  };

  it('includes only the tables the file touches', async () => {
    const diagram = await diagramFor(`ALTER TABLE users DROP COLUMN phone_number;`);
    assert.deepEqual(
      diagram.tables.map((t) => t.name),
      ['users'],
      'orgs is in the schema but untouched, so it is not in the picture',
    );
  });

  it('draws the whole table, with the touched column marked', async () => {
    const diagram = await diagramFor(`ALTER TABLE users DROP COLUMN phone_number;`);
    const users = diagram.tables[0]!;

    // Context matters: a card showing only the dropped column would not read
    // as a table.
    const names = users.columns.map((c) => c.name);
    assert.ok(names.includes('id'), 'untouched columns are still drawn');
    assert.ok(names.includes('email'));

    const dropped = users.columns.find((c) => c.name === 'phone_number')!;
    assert.equal(dropped.impact, 'drop');
    assert.equal(dropped.severity, 'destructive');
    assert.match(dropped.note!, /50 rows lose data/);

    const untouched = users.columns.find((c) => c.name === 'id')!;
    assert.equal(untouched.impact, undefined);
    assert.equal(untouched.isPrimaryKey, true);
  });

  it('carries the table size and worst severity on the card', async () => {
    const diagram = await diagramFor(`
      ALTER TABLE users DROP COLUMN nickname;
      ALTER TABLE users DROP COLUMN phone_number;
    `);
    const users = diagram.tables[0]!;
    assert.equal(users.rows, 100);
    assert.equal(users.severity, 'destructive', 'the worst of the two, not the last');
  });

  it('draws a failing foreign key as an added edge carrying its orphan count', async () => {
    const diagram = await diagramFor(
      `ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id);`,
    );

    assert.deepEqual(
      diagram.tables.map((t) => t.name).sort(),
      ['orgs', 'users'],
      'the referenced table is pulled in so the arrow has somewhere to land',
    );

    const edge = diagram.edges.find((e) => e.origin === 'added')!;
    assert.equal(edge.fromTable, 'users');
    assert.equal(edge.fromColumn, 'org_id');
    assert.equal(edge.toTable, 'orgs');
    assert.equal(edge.toColumn, 'id');
    assert.equal(edge.severity, 'blocking');
    assert.match(edge.note!, /10 orphans/);
  });

  it('marks a table that will be locked, and one that will be emptied', async () => {
    const locked = await diagramFor(`CREATE INDEX idx_users_tier ON users (tier);`);
    assert.match(locked.tables[0]!.notes[0]!.text, /locked while the index builds/);

    const emptied = await diagramFor(`TRUNCATE users;`);
    assert.equal(emptied.tables[0]!.doomed, true);
    assert.match(emptied.tables[0]!.notes[0]!.text, /emptied — 100 rows/);
  });

  it('marks the columns an UPDATE actually writes', async () => {
    const diagram = await diagramFor(`UPDATE users SET tier = 'free' WHERE tier = 'pro';`);
    const users = diagram.tables[0]!;

    const tier = users.columns.find((c) => c.name === 'tier')!;
    assert.equal(tier.impact, 'written');

    const email = users.columns.find((c) => c.name === 'email')!;
    assert.equal(email.impact, undefined, 'columns the statement leaves alone stay unmarked');

    assert.match(users.notes[0]!.text, /33 rows updated/);
  });

  it('shows a column that does not exist yet as an addition', async () => {
    const diagram = await diagramFor(`ALTER TABLE users ADD COLUMN last_seen_at timestamptz;`);
    const added = diagram.tables[0]!.columns.find((c) => c.name === 'last_seen_at')!;
    assert.equal(added.impact, 'add');
  });

  it('every marked column points at the statement that caused it', async () => {
    const diagram = await diagramFor(`
      ALTER TABLE users DROP COLUMN phone_number;
      ALTER TABLE users ALTER COLUMN email SET NOT NULL;
    `);
    const users = diagram.tables[0]!;

    assert.equal(users.columns.find((c) => c.name === 'phone_number')!.statementIndex, 0);
    assert.equal(users.columns.find((c) => c.name === 'email')!.statementIndex, 1);
  });

  it('is empty rather than wrong when no table could be identified', async () => {
    const diagram = await diagramFor(`SELECT 1;`);
    assert.deepEqual(diagram.tables, []);
    assert.deepEqual(diagram.edges, []);
  });
});
