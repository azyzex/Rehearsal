import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppliedChangeset, ChangesetHistory, describeEntry } from '../edit/history';

/**
 * The record of what was applied.
 *
 * Backed by a Memento in the extension, and by this in tests — which is the
 * reason the store is an interface rather than a `vscode.Memento`: the storage
 * rules are worth testing and none of them need an editor.
 */

class Store {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  /** Lets a test put something malformed in, the way a bad upgrade would. */
  poison(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

const entry = (overrides: Partial<AppliedChangeset> = {}) => ({
  connection: 'shop@neon',
  statements: ['ALTER TABLE users DROP COLUMN phone_number'],
  summary: '1 would destroy data. Out of 1 statement.',
  rowCounts: [null],
  ...overrides,
});

describe('the applied history', () => {
  it('starts empty', () => {
    assert.deepEqual(new ChangesetHistory(new Store()).all(), []);
  });

  it('records what ran, against what, and when', async () => {
    const history = new ChangesetHistory(new Store());
    const before = Date.now();
    const recorded = await history.record(entry());

    assert.equal(recorded.connection, 'shop@neon');
    assert.deepEqual(recorded.statements, ['ALTER TABLE users DROP COLUMN phone_number']);
    assert.ok(new Date(recorded.appliedAt).getTime() >= before);
    assert.ok(recorded.id.length > 0);
  });

  it('keeps the newest first', async () => {
    const history = new ChangesetHistory(new Store());
    await history.record(entry({ statements: ['first'] }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await history.record(entry({ statements: ['second'] }));

    assert.deepEqual(
      history.all().map((found) => found.statements[0]),
      ['second', 'first'],
    );
  });

  it('gives every entry a distinct id even inside one millisecond', async () => {
    const history = new ChangesetHistory(new Store());
    const ids = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      ids.add((await history.record(entry())).id);
    }
    // A collision would silently drop one, and the one dropped would be the
    // one somebody is looking for.
    assert.equal(ids.size, 30);
  });

  it('finds one by id', async () => {
    const history = new ChangesetHistory(new Store());
    const recorded = await history.record(entry());
    assert.equal(history.find(recorded.id)?.connection, 'shop@neon');
    assert.equal(history.find('nope'), undefined);
  });

  it('keeps the rescue file and the down migration with it', async () => {
    const history = new ChangesetHistory(new Store());
    await history.record(
      entry({ rescueFile: '.dryrun/rescue-x.sql', downSql: 'ALTER TABLE users ADD COLUMN x text;' }),
    );

    const [found] = history.all();
    assert.equal(found!.rescueFile, '.dryrun/rescue-x.sql');
    assert.match(found!.downSql!, /ADD COLUMN x/);
  });

  it('is bounded, dropping the oldest', async () => {
    // This lives in workspace state, which is loaded whole on activation. An
    // unbounded history turns into a startup cost, and an entry from two years
    // ago answers no question anyone is asking.
    const history = new ChangesetHistory(new Store());
    for (let i = 0; i < 60; i += 1) {
      await history.record(entry({ statements: [`statement ${i}`] }));
    }

    const all = history.all();
    assert.equal(all.length, 50);
    assert.equal(all[0]!.statements[0], 'statement 59');
    assert.equal(
      all.some((found) => found.statements[0] === 'statement 0'),
      false,
    );
  });

  it('can be emptied', async () => {
    const history = new ChangesetHistory(new Store());
    await history.record(entry());
    await history.clear();
    assert.deepEqual(history.all(), []);
  });

  describe('when the stored value is not what it should be', () => {
    it('survives something that is not an array', () => {
      const store = new Store();
      store.poison('dryrun.appliedChangesets', { nope: true });
      assert.deepEqual(new ChangesetHistory(store).all(), []);
    });

    it('drops entries that are the wrong shape and keeps the rest', async () => {
      // An older version of this extension, or a hand-edited state file. The
      // history is a convenience; it must never be the reason a panel fails to
      // open.
      const store = new Store();
      store.poison('dryrun.appliedChangesets', [
        { id: 'a', appliedAt: '2026-01-01T00:00:00.000Z', statements: ['x'] },
        'not an object',
        { missing: 'everything' },
        null,
      ]);

      const all = new ChangesetHistory(store).all();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.id, 'a');
    });
  });
});

describe('how an entry reads in a list', () => {
  it('leads with what it did, not when', () => {
    // The question is almost always "which one was the drop", not "what
    // happened on Tuesday".
    assert.match(
      describeEntry({
        ...entry(),
        id: 'x',
        appliedAt: '2026-01-01T00:00:00.000Z',
      } as AppliedChangeset),
      /^ALTER TABLE users DROP COLUMN phone_number$/,
    );
  });

  it('counts the rows when the server reported any', () => {
    assert.match(
      describeEntry({
        ...entry({ rowCounts: [40_072] }),
        id: 'x',
        appliedAt: '2026-01-01T00:00:00.000Z',
      } as AppliedChangeset),
      /40,072 rows$/,
    );
  });

  it('summarises a changeset rather than quoting one statement of it', () => {
    assert.match(
      describeEntry({
        ...entry({ statements: ['a', 'b', 'c'], rowCounts: [1, 2, 3] }),
        id: 'x',
        appliedAt: '2026-01-01T00:00:00.000Z',
      } as AppliedChangeset),
      /^3 changes — 6 rows$/,
    );
  });

  it('shortens a statement too long for one line', () => {
    const long = `UPDATE users SET tier = 'free' WHERE ${'x'.repeat(200)}`;
    const described = describeEntry({
      ...entry({ statements: [long] }),
      id: 'x',
      appliedAt: '2026-01-01T00:00:00.000Z',
    } as AppliedChangeset);

    assert.ok(described.length <= 60);
    assert.match(described, /…$/);
  });

  it('flattens a multi-line statement onto one line', () => {
    assert.match(
      describeEntry({
        ...entry({ statements: ['ALTER TABLE users\n  DROP COLUMN x'] }),
        id: 'x',
        appliedAt: '2026-01-01T00:00:00.000Z',
      } as AppliedChangeset),
      /^ALTER TABLE users DROP COLUMN x$/,
    );
  });
});
