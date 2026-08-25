/**
 * What has actually been applied, and how to get back.
 *
 * Apply is the one irreversible thing this extension does, and until now it
 * left no trace: the panel cleared, the diagram refreshed, and the only record
 * that anything happened was in the database. A month later "who added that
 * column" has no answer here at all.
 *
 * So each apply writes an entry: what ran, against which database, when, and —
 * the part that matters — where the rescue file and the down migration for it
 * were put. Neither is executed from here. Getting back is done by opening the
 * file and previewing it like anything else, which keeps the property that
 * nothing is written whose measured consequences have not already been shown.
 */

export interface AppliedChangeset {
  /** Sortable and unique enough for a list. */
  readonly id: string;
  readonly appliedAt: string;
  readonly connection: string;
  /** What was run, in order, as it was generated. */
  readonly statements: readonly string[];
  /** The one-line verdict the preview gave before it was applied. */
  readonly summary: string;
  /** Rows the server reported per statement. */
  readonly rowCounts: readonly (number | null)[];
  /** Where the rows it destroyed were saved, if any were. */
  readonly rescueFile?: string;
  /** The migration that reverses it, generated before it ran. */
  readonly downSql?: string;
}

/** The slice of `vscode.Memento` this needs, so the store is testable alone. */
export interface HistoryStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY = 'dryrun.appliedChangesets';

/**
 * How many to keep.
 *
 * Bounded because this lives in workspace state, which is loaded whole on every
 * activation. A history that grows without limit turns into a startup cost, and
 * an entry from two years ago answers no question anyone is asking.
 */
const LIMIT = 50;

export class ChangesetHistory {
  constructor(private readonly store: HistoryStore) {}

  /** Newest first, which is the order anyone reads this in. */
  all(): AppliedChangeset[] {
    const stored = this.store.get<unknown>(KEY, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter(isEntry).sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  }

  async record(entry: Omit<AppliedChangeset, 'id' | 'appliedAt'>): Promise<AppliedChangeset> {
    const appliedAt = new Date().toISOString();
    const full: AppliedChangeset = {
      ...entry,
      appliedAt,
      // The timestamp plus a short suffix: two applies in the same millisecond
      // is not a real scenario, and a collision here would silently drop one.
      id: `${appliedAt}-${Math.random().toString(36).slice(2, 8)}`,
    };

    await this.store.update(KEY, [full, ...this.all()].slice(0, LIMIT));
    return full;
  }

  find(id: string): AppliedChangeset | undefined {
    return this.all().find((entry) => entry.id === id);
  }

  async clear(): Promise<void> {
    await this.store.update(KEY, []);
  }
}

/**
 * A one-line description for a list.
 *
 * Leads with what it did rather than when, because the question is almost
 * always "which one was the drop" rather than "what happened on Tuesday".
 */
export function describeEntry(entry: AppliedChangeset): string {
  const count = entry.statements.length;
  const rows = entry.rowCounts.reduce<number>((sum, value) => sum + (value ?? 0), 0);

  const what =
    count === 1 ? firstWords(entry.statements[0] ?? '') : `${count} changes`;

  return rows > 0
    ? `${what} — ${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`
    : what;
}

/** Enough of a statement to recognise it, on one line. */
function firstWords(sql: string, limit = 60): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function isEntry(value: unknown): value is AppliedChangeset {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['appliedAt'] === 'string' &&
    Array.isArray(entry['statements'])
  );
}
