import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify } from '../parser/classifier';
import { rewritesFor } from '../analysis/rewrite';
import { Finding } from '../analysis/types';

/**
 * The same statement, written the way each database writes it.
 *
 * Every one of these came from running the CLI against a real MySQL testbed
 * and reading what the panel said. Three statements came back as "not
 * analysed" — the panel saying nothing at all about changes that would each
 * fail on real data — and one came back with advice that is a syntax error on
 * the database it was given about.
 */

describe('MySQL writes the same DDL with different words', () => {
  it('reads MODIFY … NOT NULL as requiring the column', () => {
    // Postgres says ALTER COLUMN email SET NOT NULL. MySQL restates the whole
    // column, and the classifier only knew the first form.
    const found = classify('ALTER TABLE authors MODIFY email VARCHAR(255) NOT NULL');
    assert.equal(found.kind, 'set_not_null');
    assert.equal(found.table, 'authors');
    assert.equal(found.column, 'email');
  });

  it('reads MODIFY … NULL as dropping the requirement', () => {
    const found = classify('ALTER TABLE authors MODIFY email VARCHAR(255) NULL');
    assert.equal(found.kind, 'drop_not_null');
    assert.equal(found.column, 'email');
  });

  it('reads a MODIFY that only restates the type as a type change', () => {
    const found = classify('ALTER TABLE posts MODIFY title VARCHAR(100)');
    assert.equal(found.kind, 'alter_column_type');
    assert.equal(found.column, 'title');
    assert.equal(found.newType, 'VARCHAR(100)');
  });

  it('reads CHANGE as a rename', () => {
    const found = classify('ALTER TABLE posts CHANGE headline title VARCHAR(200)');
    assert.equal(found.kind, 'rename_column');
    assert.equal(found.column, 'headline');
  });

  it('reads ADD UNIQUE KEY, which Postgres spells ADD UNIQUE', () => {
    const found = classify('ALTER TABLE authors ADD UNIQUE KEY authors_email_key (email)');
    assert.equal(found.kind, 'add_unique');
    assert.deepEqual(found.columns, ['email']);
  });

  it('reads ADD UNIQUE INDEX the same way', () => {
    const found = classify('ALTER TABLE authors ADD UNIQUE INDEX ix (email, name)');
    assert.equal(found.kind, 'add_unique');
    assert.deepEqual(found.columns, ['email', 'name']);
  });

  it('still reads the Postgres form', () => {
    const found = classify('ALTER TABLE authors ADD UNIQUE (email)');
    assert.equal(found.kind, 'add_unique');
    assert.deepEqual(found.columns, ['email']);
  });

  it('reads ADD KEY as the index build it is', () => {
    // MySQL's inline CREATE INDEX. It takes the same lock and deserves the
    // same warning.
    const found = classify('ALTER TABLE comments ADD KEY idx_post (post_id)');
    assert.equal(found.kind, 'create_index');
    assert.deepEqual(found.columns, ['post_id']);
  });

  it('does not mistake ADD COLUMN for any of them', () => {
    const found = classify('ALTER TABLE authors ADD COLUMN twitter varchar(40)');
    assert.equal(found.kind, 'add_column');
    assert.equal(found.column, 'twitter');
  });
});

describe('advice that runs on the database it is given about', () => {
  const finding = (): Finding => ({
    statementIndex: 0,
    kind: 'create_index',
    classification: { kind: 'create_index', table: 'comments', columns: ['post_id'] },
    severity: 'blocking',
    headline: 'Will lock the table',
    detail: 'comments has about 400,000 rows.',
  });

  it('offers CONCURRENTLY on Postgres', () => {
    const rewrites = rewritesFor(finding(), 'postgres');
    assert.ok(rewrites.length > 0);
    assert.ok(rewrites.some((rewrite) => /CONCURRENTLY/.test(rewrite.statements.join(' '))));
  });

  it('offers nothing on MySQL rather than a statement that will not run', () => {
    // CONCURRENTLY is a Postgres keyword. Handing it to a MySQL user costs
    // them the attempt and the trust they had in the rest of the row.
    assert.deepEqual(rewritesFor(finding(), 'mysql'), []);
  });

  it('offers nothing on MongoDB either', () => {
    assert.deepEqual(rewritesFor(finding(), 'mongo'), []);
  });

  it('defaults to Postgres, which is what the callers without an engine mean', () => {
    assert.ok(rewritesFor(finding()).length > 0);
  });
});
