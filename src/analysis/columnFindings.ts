import { ColumnStatistic, DatabaseAdapter } from '../adapters/types';

/**
 * What the data already says about its own columns.
 *
 * Everything else in Rehearsal asks "will this change fail?". This asks the
 * reverse question, of the schema you already have:
 *
 *   - which columns are never filled in, and might be dead;
 *   - which nullable columns never hold a null, and could be required;
 *   - which columns are unique in practice, and have nothing enforcing it;
 *   - which text columns only ever hold a handful of values.
 *
 * Candidates come from the planner's statistics, which are free to read and
 * approximate by nature — they are a sample. So every candidate is verified
 * with an exact count before it is reported, and a candidate that does not
 * survive the count is dropped without a word. A suggestion to add a NOT NULL
 * that would fail on row 40,001 is worse than no suggestion.
 */

export interface ColumnFindings {
  /** Never holds a value. The reference count is filled in by the caller. */
  readonly neverFilled: readonly { table: string; column: string; rows: number }[];
  /** Nullable, but no row is null. */
  readonly couldRequire: readonly { table: string; column: string; rows: number }[];
  /** Every value distinct, and no unique index says so. */
  readonly uniqueInPractice: readonly { table: string; column: string; rows: number }[];
  /** A text column with only a few values in it. */
  readonly fewValues: readonly { table: string; column: string; values: readonly string[] }[];
  /** Set when there were more candidates than were checked. */
  readonly truncated?: number;
}

/** Enough rows for "never null" and "every value different" to mean something. */
const MEANINGFUL_ROWS = 100;
/** Exact counts are real queries; past this many the report stops checking. */
const CHECK_LIMIT = 30;

export async function findColumnOpportunities(
  adapter: DatabaseAdapter,
  statistics: readonly ColumnStatistic[],
  rowsByTable: ReadonlyMap<string, number>,
): Promise<ColumnFindings> {
  const quote = adapter.quoteIdentifier?.bind(adapter);
  if (!quote) {
    return { neverFilled: [], couldRequire: [], uniqueInPractice: [], fewValues: [] };
  }

  type Candidate = { kind: 'never' | 'require' | 'unique' | 'few'; stat: ColumnStatistic; rows: number };
  const candidates: Candidate[] = [];

  for (const stat of statistics) {
    const rows = rowsByTable.get(stat.table) ?? 0;
    if (rows < MEANINGFUL_ROWS) {
      continue;
    }

    if (stat.nullFraction >= 1) {
      candidates.push({ kind: 'never', stat, rows });
    } else if (stat.nullable && stat.nullFraction === 0) {
      candidates.push({ kind: 'require', stat, rows });
    }

    if (stat.distinct === -1 && !stat.uniqueIndexed) {
      candidates.push({ kind: 'unique', stat, rows });
    }

    if (
      stat.distinct >= 2 &&
      stat.distinct <= 6 &&
      stat.commonValues.length === stat.distinct &&
      /char|text/i.test(stat.type) &&
      rows >= 1000
    ) {
      candidates.push({ kind: 'few', stat, rows });
    }
  }

  const checked = candidates.slice(0, CHECK_LIMIT);
  const neverFilled: { table: string; column: string; rows: number }[] = [];
  const couldRequire: { table: string; column: string; rows: number }[] = [];
  const uniqueInPractice: { table: string; column: string; rows: number }[] = [];
  const fewValues: { table: string; column: string; values: readonly string[] }[] = [];

  for (const { kind, stat, rows } of checked) {
    try {
      const column = quote(stat.column);

      if (kind === 'never' && (await adapter.countNonNull(stat.table, stat.column)) === 0) {
        neverFilled.push({ table: stat.table, column: stat.column, rows });
      }

      if (kind === 'require') {
        const total = await adapter.countRows(stat.table);
        if ((await adapter.countNonNull(stat.table, stat.column)) === total) {
          couldRequire.push({ table: stat.table, column: stat.column, rows: total });
        }
      }

      if (kind === 'unique') {
        const duplicates = await adapter.countDuplicates(stat.table, [stat.column]);
        if (duplicates.rows === 0) {
          uniqueInPractice.push({ table: stat.table, column: stat.column, rows });
        }
      }

      if (kind === 'few') {
        const list = stat.commonValues.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
        // countViolating counts rows where the predicate is false.
        const outside = await adapter.countViolating(
          stat.table,
          `${column} IS NULL OR ${column} IN (${list})`,
        );
        if (outside === 0) {
          fewValues.push({ table: stat.table, column: stat.column, values: stat.commonValues });
        }
      }
    } catch {
      // A candidate that cannot be checked is not reported. The report only
      // says what it measured.
    }
  }

  return {
    neverFilled,
    couldRequire,
    uniqueInPractice,
    fewValues,
    ...(candidates.length > checked.length ? { truncated: candidates.length - checked.length } : {}),
  };
}

/**
 * The findings as report sections. `references` is how many places in the
 * workspace mention each never-filled column, when it was searched.
 */
export function columnSections(
  findings: ColumnFindings,
  references: ReadonlyMap<string, number>,
): string[] {
  const lines: string[] = [];

  if (findings.neverFilled.length > 0) {
    lines.push(
      '## Columns nothing has ever filled in',
      '',
      'Every row has no value in these. Where no code mentions them either, they may be',
      'left over from something that was removed. Dropping one is instant and destroys',
      'nothing, because there is nothing in it — but check the code search below, which',
      'is a text search and cannot see a query built at runtime.',
      '',
      '| Column | Rows | Mentions in this workspace |',
      '| --- | ---: | --- |',
      ...findings.neverFilled.map((entry) => {
        const key = `${entry.table}.${entry.column}`;
        const mentions = references.get(key);
        return `| \`${key}\` | ${entry.rows.toLocaleString()} | ${
          mentions === undefined ? 'not searched' : mentions === 0 ? '**none**' : mentions
        } |`;
      }),
      '',
    );
  }

  if (findings.couldRequire.length > 0) {
    lines.push(
      '## Nullable columns that are never null',
      '',
      'Counted, not sampled: every row has a value. Making them `NOT NULL` states what',
      'the data already does, and stops the first null from arriving. Preview the change',
      'before applying it — on a large table the plain form holds a lock for a full scan.',
      '',
      ...findings.couldRequire.map(
        (entry) => `- \`${entry.table}.${entry.column}\` — all ${entry.rows.toLocaleString()} rows`,
      ),
      '',
    );
  }

  if (findings.uniqueInPractice.length > 0) {
    lines.push(
      '## Columns that are unique, with nothing enforcing it',
      '',
      'Counted: no two rows share a value. If that is meant to hold, a unique index makes',
      'it hold — and lookups by the column fast. If it is a coincidence of the data so',
      'far, leave it.',
      '',
      ...findings.uniqueInPractice.map(
        (entry) => `- \`${entry.table}.${entry.column}\` — ${entry.rows.toLocaleString()} rows, all different`,
      ),
      '',
    );
  }

  if (findings.fewValues.length > 0) {
    lines.push(
      '## Text columns with only a few values',
      '',
      'Every row holds one of these. A check constraint would keep it that way, and',
      'catch a typo the first time one is written.',
      '',
      ...findings.fewValues.map(
        (entry) =>
          `- \`${entry.table}.${entry.column}\` — ${entry.values.map((value) => `\`${value}\``).join(', ')}`,
      ),
      '',
    );
  }

  if (findings.truncated) {
    lines.push(
      `_${findings.truncated} more candidates were not checked. Each one is an exact count, ` +
        'and the report stops before it becomes the slowest thing you run today._',
      '',
    );
  }

  return lines;
}
