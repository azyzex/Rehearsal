import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoAdapter } from '../adapters/mongo';
import { analyzeStatements } from '../analysis/orchestrator';
import { Finding } from '../analysis/types';
import { languageFor } from '../parser/language';
import { APPLICATION_NAME } from '../constants';
import { MongoFixture, seedMongo, startMongo } from './support/mongoFixture';

/**
 * A MongoDB migration, through the whole pipeline.
 *
 * The adapter tests prove the adapter works. This proves it is reachable —
 * which for a while it was not, because the pipeline split every file with the
 * SQL splitter and classified every statement with the SQL classifier, so a
 * perfectly good Mongo adapter sat behind a door nothing could open.
 *
 * These go in at the top, with the text of a migration file, and come out with
 * findings. Nothing in between is told which database it is talking to.
 */

const MIGRATION = `
// Retire the free tier and clean up.
db.users.updateMany({ tier: "free" }, { $set: { tier: "basic" } });

// Drop the phone numbers we never used.
db.users.updateMany({}, { $unset: { phone_number: "" } });

// Everything, with no filter at all.
db.orders.deleteMany({});

db.users.createIndex({ email: 1 }, { unique: true });
`;

describe('a mongo migration, end to end', () => {
  let fixture: MongoFixture;
  let adapter: MongoAdapter;
  let findings: Finding[];

  before(async () => {
    fixture = await startMongo();
    await seedMongo(fixture.db());

    adapter = new MongoAdapter();
    await adapter.connect({
      connectionString: fixture.uri,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 5000,
      applicationName: APPLICATION_NAME,
    });

    const language = languageFor(adapter.engine);
    const statements = language.split(MIGRATION);

    findings = [];
    await analyzeStatements({
      adapter,
      statements,
      thresholds: {
        cautionRows: 10,
        destructiveRows: 30,
        largeTable: 100_000,
        sampleSize: 3,
        explainAnalyze: false,
      },
      onFinding: (finding) => findings.push(finding),
    });
  });

  after(async () => {
    await adapter?.dispose();
    await fixture?.stop();
  });

  it('reads every operation in the file', () => {
    assert.equal(findings.length, 4, `got ${findings.map((f) => f.headline).join(' | ')}`);
  });

  it('measures the update against the real documents', () => {
    const update = findings[0]!;
    assert.equal(update.kind, 'update');
    // 67 of 100 users are on the free tier in the fixture, and that number
    // came from running the update and counting, not from reading the filter.
    assert.equal(update.rowCount, 67);
    assert.match(update.detail, /67/);
  });

  it('leaves the documents alone afterwards', async () => {
    // The update above really ran. If the transaction had not been aborted,
    // this is where it would show.
    assert.equal(await adapter.countRows('users', '{"tier":"basic"}'), 0);
    assert.equal(await adapter.countRows('users', '{"tier":"free"}'), 67);
  });

  it('reads a $unset as dropping a field, and counts what it would remove', () => {
    const unset = findings[1]!;
    assert.equal(unset.kind, 'drop_column');
    // Half the users have a phone number, and the panel says so before
    // anything is removed.
    assert.equal(unset.rowCount, 50);
    assert.equal(unset.severity, 'destructive');
  });

  it('calls a delete with no filter what it is', () => {
    const remove = findings[2]!;
    assert.equal(remove.kind, 'delete');
    assert.equal(remove.severity, 'destructive');
    assert.equal(remove.rowCount, 40, 'every order in the collection');
  });

  it('does not run the index creation, and says what it would cost', () => {
    const index = findings[3]!;
    assert.equal(index.kind, 'create_index');
    // Probed rather than executed — MongoDB would refuse it inside the
    // transaction anyway, and building it to find out would take the lock the
    // preview exists to warn about.
    assert.ok(index.headline.length > 0);
  });

  it('leaves the index it did not build unbuilt', async () => {
    const indexes = await fixture.db().collection('users').indexes();
    assert.deepEqual(
      indexes.map((index) => index['name']),
      ['_id_'],
      'nothing was created',
    );
  });

  it('carries positions, so every row can jump to its line', () => {
    for (const finding of findings) {
      const statement = languageFor('mongo').split(MIGRATION)[finding.statementIndex]!;
      assert.equal(
        MIGRATION.slice(statement.startOffset, statement.startOffset + statement.sql.length),
        statement.sql,
      );
      assert.ok(statement.startLine > 0, 'and the line is where the statement really is');
    }
  });

  it('says plainly when it cannot read an operation', async () => {
    // The alternative is running the file to find out what `cutoff` is, which
    // is the thing this whole extension exists not to do.
    const unreadable: Finding[] = [];
    await analyzeStatements({
      adapter,
      statements: languageFor('mongo').split(
        `db.orders.deleteMany({ createdAt: { $lt: cutoff } })`,
      ),
      thresholds: {
        cautionRows: 10,
        destructiveRows: 30,
        largeTable: 100_000,
        sampleSize: 3,
        explainAnalyze: false,
      },
      onFinding: (finding) => unreadable.push(finding),
    });

    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0]!.kind, 'other');
  });
});
