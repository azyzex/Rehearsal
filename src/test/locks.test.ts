import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres';
import { analyzeStatements } from '../analysis/orchestrator';
import { describeBlocker, lockProfileFor, wouldQueue } from '../analysis/locks';
import { DEFAULT_THRESHOLDS, Finding } from '../analysis/types';
import { APPLICATION_NAME } from '../constants';
import { splitStatements } from '../parser/splitter';
import { PostgresFixture, startPostgres } from './support/pgFixture';

/**
 * The lock outlook.
 *
 * Every other number in this tool assumes the statement runs unobstructed, and
 * that assumption is wrong in exactly the situation that causes outages. A DDL
 * statement waiting behind a long-running reader does not merely wait: Postgres
 * queues lock requests fairly, so every query arriving afterwards queues behind
 * the *waiting* DDL — including reads that conflict with nothing. That is how a
 * routine ADD COLUMN takes a site down for twenty minutes.
 */

describe('lock profiles', () => {
  it('separates a brief exclusive lock from one held across a table scan', () => {
    // Both take ACCESS EXCLUSIVE, and the difference between them is the
    // difference between a blip and an outage.
    const drop = lockProfileFor('drop_column');
    assert.equal(drop.level, 'ACCESS EXCLUSIVE');
    assert.equal(drop.brief, true, 'a catalog edit');

    const notNull = lockProfileFor('set_not_null');
    assert.equal(notNull.level, 'ACCESS EXCLUSIVE');
    assert.equal(notNull.brief, false, 'held while every row is scanned');
  });

  it('knows CONCURRENTLY changes the lock, not just the speed', () => {
    assert.equal(lockProfileFor('create_index', { concurrently: false }).level, 'SHARE');
    assert.equal(
      lockProfileFor('create_index', { concurrently: true }).level,
      'SHARE UPDATE EXCLUSIVE',
    );
    assert.match(lockProfileFor('create_index', { concurrently: true }).blocks, /nothing/);
  });

  it('reports a foreign key as locking both tables', () => {
    // The part people forget: adding a key to a small table blocks writes on
    // the large one it points at.
    assert.match(lockProfileFor('add_foreign_key').blocks, /both tables/);
  });

  it('says a plain read blocks nothing', () => {
    assert.equal(lockProfileFor('select').level, 'ACCESS SHARE');
  });
});

describe('wouldQueue', () => {
  const blocker = (lockMode: string) => ({
    pid: 1,
    state: 'active',
    applicationName: 'reporting',
    query: 'SELECT ...',
    seconds: 900,
    lockMode,
  });

  it('makes an exclusive lock wait for even a plain reader', () => {
    // This is the whole mechanism. ACCESS SHARE conflicts with ACCESS
    // EXCLUSIVE, so an ordinary SELECT delays a DROP COLUMN, and everything
    // behind it.
    const queued = wouldQueue(lockProfileFor('drop_column'), [blocker('AccessShareLock')]);
    assert.equal(queued.length, 1);
  });

  it('does not make a read wait for anything', () => {
    assert.deepEqual(wouldQueue(lockProfileFor('select'), [blocker('AccessExclusiveLock')]), []);
  });

  it('lets a concurrent index build past an ordinary reader', () => {
    const queued = wouldQueue(
      lockProfileFor('create_index', { concurrently: true }),
      [blocker('AccessShareLock')],
    );
    assert.deepEqual(queued, []);
  });

  it('treats an unrecognised lock mode as conflicting', () => {
    // Being wrong in the permissive direction here means telling someone their
    // migration is safe when it is about to queue. Being wrong the other way
    // is a spurious warning.
    const queued = wouldQueue(lockProfileFor('add_unique'), [blocker('SomethingNewLock')]);
    assert.equal(queued.length, 1);
  });
});

describe('describeBlocker', () => {
  it('calls out an idle transaction as the worse case', () => {
    const text = describeBlocker({
      pid: 42,
      state: 'idle in transaction',
      applicationName: 'psql',
      query: 'BEGIN',
      seconds: 600,
      lockMode: 'RowExclusiveLock',
    });
    assert.match(text, /idle transaction/);
    assert.match(text, /10 minutes/);
    assert.match(text, /pid 42/);
  });

  it('reports a running query with its duration', () => {
    const text = describeBlocker({
      pid: 7,
      state: 'active',
      applicationName: 'reporting-worker',
      query: 'SELECT ...',
      seconds: 45,
      lockMode: 'AccessShareLock',
    });
    assert.match(text, /running for 45 seconds/);
    assert.match(text, /reporting-worker/);
  });
});

describe('against a real database', () => {
  let fixture: PostgresFixture;
  let adapter: PostgresAdapter;

  before(async () => {
    fixture = await startPostgres();
    adapter = new PostgresAdapter();
    await adapter.connect({
      connectionString: fixture.connectionString,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 1000,
      applicationName: APPLICATION_NAME,
    });
  });

  after(async () => {
    await adapter?.dispose();
    await fixture?.stop();
  });

  const analyse = async (sql: string): Promise<Finding[]> => {
    const findings: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: splitStatements(sql),
      thresholds: DEFAULT_THRESHOLDS,
      onFinding: (finding) => findings.push(finding),
    });
    return findings;
  };

  it('says nothing about queuing when nothing is in the way', async () => {
    const finding = (await analyse('ALTER TABLE users DROP COLUMN nickname'))[0]!;
    assert.equal(finding.lock?.level, 'ACCESS EXCLUSIVE');
    assert.equal(finding.queuedBehind, undefined, 'the quiet case stays quiet');
  });

  it('sees a real session holding a real lock', async () => {
    const holder = new Client({ connectionString: fixture.connectionString });
    await holder.connect();

    try {
      await holder.query(`SET application_name = 'long-report'`);
      await holder.query('BEGIN');
      await holder.query('SELECT count(*) FROM users');
      // Left open: an idle transaction still holds everything it touched, and
      // is the classic cause of a queued migration.

      const holders = await adapter.lockHolders('users');
      const found = holders.find((h) => h.applicationName === 'long-report');

      assert.ok(found, 'the open transaction is visible');
      assert.match(found!.lockMode, /AccessShare/);
      assert.equal(found!.state, 'idle in transaction');
      assert.ok(found!.seconds >= 0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  });

  it('warns that a DDL statement would queue behind it, and everything behind that', async () => {
    const holder = new Client({ connectionString: fixture.connectionString });
    await holder.connect();

    try {
      await holder.query(`SET application_name = 'long-report'`);
      await holder.query('BEGIN');
      await holder.query('SELECT count(*) FROM users');

      const finding = (await analyse('ALTER TABLE users DROP COLUMN nickname'))[0]!;

      assert.ok(finding.queuedBehind?.length, 'the blocker was found');
      assert.equal(
        finding.severity,
        'blocking',
        'a statement that would queue is not safe, whatever it does to the data',
      );
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  });

  it('does not warn about a reader when the index is built concurrently', async () => {
    const holder = new Client({ connectionString: fixture.connectionString });
    await holder.connect();

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT count(*) FROM users');

      const finding = (await analyse('CREATE INDEX CONCURRENTLY idx_x ON users (tier)'))[0]!;
      assert.equal(finding.queuedBehind, undefined, 'that is the point of CONCURRENTLY');
      assert.equal(finding.severity, 'safe');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  });

  it('excludes its own session from the blockers it reports', async () => {
    // The preview holds a lock of its own while measuring. Reporting that back
    // would be both wrong and permanent.
    const holders = await adapter.lockHolders('users');
    assert.equal(
      holders.some((h) => h.applicationName === APPLICATION_NAME),
      false,
    );
  });

  it('degrades quietly when the table does not exist', async () => {
    assert.deepEqual(await adapter.lockHolders('no_such_table_at_all'), []);
  });
});
