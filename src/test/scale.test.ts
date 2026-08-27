import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scaleNote } from '../analysis/scale';
import { Finding } from '../analysis/types';

/**
 * What a measurement means against the database you deploy to.
 *
 * Pure arithmetic on two numbers, which is why it can be tested without a
 * database at all — and why it has to be, because the numbers it produces are
 * the ones someone will plan a maintenance window around.
 */

function finding(over: Partial<Finding> = {}): Finding {
  return {
    statementIndex: 0,
    kind: 'update',
    classification: { kind: 'update', table: 'users' },
    severity: 'caution',
    headline: 'Changes rows',
    detail: '100 rows in users are updated.',
    ...over,
  } as Finding;
}

describe('what a measurement means at production size', () => {
  it('says nothing at all without the sizes', () => {
    assert.equal(scaleNote(finding(), 100, undefined), undefined);
    assert.equal(scaleNote(finding(), 100, {}), undefined);
  });

  it('is loudest about the table that is empty here', () => {
    // The dangerous case, not the harmless one. Every probe answers zero,
    // every row is green, and none of it is about the database in the sentence.
    const note = scaleNote(finding(), 0, { users: 40_000_000 });

    assert.match(String(note), /empty here/);
    assert.match(String(note), /40,000,000/);
    assert.match(String(note), /says anything about that one/);
  });

  it('says the numbers carry over when the two are close', () => {
    const note = scaleNote(finding(), 40_000, { users: 41_000 });
    assert.match(String(note), /about the same/);
    assert.match(String(note), /carry over/);
  });

  it('calls this database the upper bound when it is the larger one', () => {
    const note = scaleNote(finding(), 100_000, { users: 1_000 });
    assert.match(String(note), /fewer than here/);
    assert.match(String(note), /upper bound/);
  });

  it('scales a row count proportionally, and says that is what it did', () => {
    const note = scaleNote(finding({ rowCount: 40 }), 40_000, { users: 40_000_000 });

    assert.match(String(note), /1000× the size of/);
    assert.match(String(note), /40,000/, 'the projection');
    assert.match(String(note), /same share of rows/, 'labelled as the assumption it is');
  });

  /**
   * The one that would be wrong if it multiplied.
   *
   * An index build is not linear in the row count, so scaling 900ms by 1000
   * would give fifteen minutes where the real answer is nearer twelve. Both are
   * "about the same size of problem", which is exactly why the wrong one would
   * never be caught.
   */
  it('recomputes an index build rather than multiplying it', () => {
    const build = finding({
      kind: 'create_index',
      classification: { kind: 'create_index', table: 'orders', concurrently: false },
      rowCount: 40_000,
      detail: 'orders has about 40,000 rows.',
    });

    const note = String(scaleNote(build, 40_000, { orders: 40_000_000 }));

    assert.match(note, /The build there is roughly/);
    assert.match(note, /rather than/);
    assert.doesNotMatch(note, /same share of rows/, 'it took the row-count path');
  });

  it('finds the table however the setting spells its name', () => {
    const qualified = finding({
      classification: { kind: 'update', table: 'public.users' },
      rowCount: 10,
    });

    assert.ok(scaleNote(qualified, 100, { users: 1_000_000 }), 'bare name in the setting');
    assert.ok(scaleNote(finding({ rowCount: 10 }), 100, { 'public.users': 1_000_000 }), 'qualified');
  });
});
