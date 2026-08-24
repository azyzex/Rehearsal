import { QueryPlan } from '../adapters/types';
import { rootOf, walk } from '../adapters/planShape';

/**
 * Which index would help, read off the plan the database already gave us.
 *
 * The advice every index tuner gives is "look at your sequential scans", which
 * is true and useless: a sequential scan over a hundred rows is the right plan,
 * and the same node over forty million is the problem. The number that tells
 * them apart is already in the plan — `Rows Removed by Filter` — and so are the
 * columns doing the removing. Both go unread because nobody reads plan JSON.
 *
 * Everything here is pure. It takes a plan and the table's columns and returns
 * candidate indexes; whether an index actually helps is a question only the
 * planner can answer, and that happens in `hypothetical.ts`.
 */

/** A sequential scan worth caring about. */
export interface ScanNode {
  readonly relation: string;
  readonly alias: string;
  readonly filter?: string;
  readonly totalCost: number;
  readonly planRows: number;
  /** Rows the filter threw away, when the plan was run with ANALYZE. */
  readonly rowsRemoved?: number;
  /** Rows the node actually returned, when the plan was run with ANALYZE. */
  readonly actualRows?: number;
}

export interface IndexCandidate {
  readonly table: string;
  readonly columns: readonly string[];
  /** Why this one, in a sentence that stands on its own. */
  readonly reason: string;
  /** `CREATE INDEX ON t (a, b)`, ready to test. */
  readonly sql: string;
  /** The scan it came from, so the caller can show what it would replace. */
  readonly scan: ScanNode;
}

/** Sequential scans in the plan, in the order the planner listed them. */
export function seqScans(plan: QueryPlan): ScanNode[] {
  const scans: ScanNode[] = [];
  for (const node of walk(rootOf(plan))) {
    if (node['Node Type'] !== 'Seq Scan') {
      continue;
    }
    const relation = typeof node['Relation Name'] === 'string' ? node['Relation Name'] : undefined;
    if (!relation) {
      continue;
    }
    scans.push({
      relation,
      alias: typeof node['Alias'] === 'string' ? node['Alias'] : relation,
      filter: typeof node['Filter'] === 'string' ? node['Filter'] : undefined,
      totalCost: numberOr(node['Total Cost'], 0),
      planRows: numberOr(node['Plan Rows'], 0),
      rowsRemoved: optionalNumber(node['Rows Removed by Filter']),
      actualRows: optionalNumber(node['Actual Rows']),
    });
  }
  return scans;
}

/** The sort keys the plan asked for, which an index can sometimes supply for free. */
export function sortKeys(plan: QueryPlan): string[][] {
  const keys: string[][] = [];
  for (const node of walk(rootOf(plan))) {
    if (node['Node Type'] !== 'Sort' || !Array.isArray(node['Sort Key'])) {
      continue;
    }
    keys.push((node['Sort Key'] as unknown[]).map(String));
  }
  return keys;
}

/**
 * Columns a filter expression tests, split by how it tests them.
 *
 * The split matters because a btree index only helps up to and including its
 * first range column: `(status, created_at)` serves `status = 'x' AND
 * created_at > y`, while `(created_at, status)` serves only the date. Getting
 * that order wrong produces an index that is built, maintained, and unused.
 */
export function filterColumns(
  filter: string,
  knownColumns: readonly string[],
  alias?: string,
): { equality: string[]; range: string[] } {
  const known = new Set(knownColumns);
  const equality: string[] = [];
  const range: string[] = [];

  const tokens = [
    ...filter.matchAll(/"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)|(<>|>=|<=|!=|=|<|>)|(\S)/g),
  ];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const name = token[1] ?? token[2];
    if (name === undefined) {
      continue;
    }

    // `orders.status` and `o.status` both name a column; the qualifier only
    // matters when it says the column belongs to a different table.
    let column = name;
    let cursor = i;
    if (tokens[cursor + 1]?.[4] === '.' && tokens[cursor + 2]) {
      const qualified = tokens[cursor + 2]![1] ?? tokens[cursor + 2]![2];
      if (qualified === undefined) {
        continue;
      }
      if (alias !== undefined && name !== alias) {
        // Belongs to another table in the join. Skip past the whole reference
        // so its column name is not read as one of ours next time round.
        i = cursor + 2;
        continue;
      }
      column = qualified;
      cursor += 2;
    }

    if (!known.has(column)) {
      continue;
    }

    // How many closing parens after the column belong to groupings that opened
    // just before it, as in `((status)::text = 'paid'::text)`. A paren opened
    // by a function — `length(payload)` — does not count, and this is the
    // difference between advising an index that serves the query and advising
    // one the planner will never touch: no btree on `payload` answers
    // `length(payload) = 4`.
    let wrapping = 0;
    for (let back = i - 1; back >= 0 && tokens[back]?.[4] === '('; back -= 1) {
      const before = tokens[back - 1];
      const isCall = before !== undefined && (before[1] ?? before[2]) !== undefined;
      if (isCall) {
        break;
      }
      wrapping += 1;
    }

    // Casts also sit between the column and the operator.
    let next = cursor + 1;
    while (next < tokens.length) {
      const symbol = tokens[next]?.[4];
      if (symbol === ')' && wrapping > 0) {
        wrapping -= 1;
        next += 1;
        continue;
      }
      if (symbol === ':') {
        next += 1;
        // `::` is two tokens, and a type name follows it.
        if (tokens[next]?.[4] === ':') {
          next += 1;
        }
        while ((tokens[next]?.[1] ?? tokens[next]?.[2]) !== undefined) {
          next += 1;
        }
        continue;
      }
      break;
    }

    const operator = tokens[next]?.[3];
    if (operator === '=') {
      push(equality, column);
    } else if (operator !== undefined && operator !== '<>' && operator !== '!=') {
      push(range, column);
    }
    i = cursor;
  }

  return { equality, range: range.filter((column) => !equality.includes(column)) };
}

export interface CandidateOptions {
  /** Columns of each table in the plan, keyed by relation name. */
  readonly columnsByTable: ReadonlyMap<string, readonly string[]>;
  /**
   * Below this, a sequential scan is the right plan and an index is overhead.
   * Applied to the rows the filter had to read, not the rows it returned.
   */
  readonly minimumRowsRead?: number;
}

/**
 * Indexes worth testing, best first.
 *
 * Deliberately conservative: at most one index per scan, made of columns the
 * filter actually tests. A tool that proposes six indexes for one query has
 * told you nothing — the work of deciding is still entirely yours.
 */
export function indexCandidates(plan: QueryPlan, options: CandidateOptions): IndexCandidate[] {
  const minimum = options.minimumRowsRead ?? 1000;
  const candidates: IndexCandidate[] = [];

  for (const scan of seqScans(plan)) {
    if (!scan.filter) {
      // Nothing to narrow by. A scan with no filter reads the table because
      // the query asked for the table.
      continue;
    }

    const columns = options.columnsByTable.get(scan.relation);
    if (!columns || columns.length === 0) {
      continue;
    }

    const read = rowsRead(scan);
    if (read !== undefined && read < minimum) {
      continue;
    }

    const { equality, range } = filterColumns(scan.filter, columns, scan.alias);
    // Only the first range column earns a place: everything after it in a
    // btree is dead weight.
    const indexColumns = [...equality, ...range.slice(0, 1)];
    if (indexColumns.length === 0) {
      continue;
    }

    candidates.push({
      table: scan.relation,
      columns: indexColumns,
      reason: reasonFor(scan, indexColumns),
      sql: `CREATE INDEX ON ${quote(scan.relation)} (${indexColumns.map(quote).join(', ')})`,
      scan,
    });
  }

  // The scan reading the most rows is the one worth fixing first.
  return candidates.sort((a, b) => (rowsRead(b.scan) ?? 0) - (rowsRead(a.scan) ?? 0));
}

/** Rows the scan had to look at. Measured when available, unknown otherwise. */
export function rowsRead(scan: ScanNode): number | undefined {
  if (scan.rowsRemoved !== undefined && scan.actualRows !== undefined) {
    return scan.rowsRemoved + scan.actualRows;
  }
  if (scan.rowsRemoved !== undefined) {
    return scan.rowsRemoved;
  }
  return undefined;
}

function reasonFor(scan: ScanNode, columns: readonly string[]): string {
  const list = columns.join(', ');
  const read = rowsRead(scan);
  if (read !== undefined && scan.actualRows !== undefined) {
    return (
      `${scan.relation} is read end to end — ${read.toLocaleString()} rows examined to ` +
      `return ${scan.actualRows.toLocaleString()}. The filter tests ${list}.`
    );
  }
  return `${scan.relation} is scanned in full and the filter tests ${list}.`;
}

function push(list: string[], column: string): void {
  if (!list.includes(column)) {
    list.push(column);
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

