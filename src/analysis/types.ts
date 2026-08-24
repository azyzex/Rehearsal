import { Classification, StatementKind } from '../parser/classifier';
import { Row } from '../adapters/types';
import { CascadeNode } from '../adapters/types';
import { Blocker, LockProfile } from './locks';
import { AnalysedPlan } from './plan';

export type Severity = 'safe' | 'caution' | 'blocking' | 'destructive';

export interface Thresholds {
  /** Rows affected above which an UPDATE or DELETE is `caution`. */
  readonly cautionRows: number;
  /** Rows affected above which an UPDATE or DELETE is `destructive`. */
  readonly destructiveRows: number;
  /** Row count above which a table is "large" for lock and index warnings. */
  readonly largeTable: number;
  /** How many affected rows to show in a before/after sample. */
  readonly sampleSize: number;
  /**
   * Capture a query plan for DML. Off by default: EXPLAIN ANALYZE runs the
   * statement a second time, so it roughly doubles the cost of a preview.
   */
  readonly explainAnalyze?: boolean;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  cautionRows: 100,
  destructiveRows: 1000,
  largeTable: 100_000,
  sampleSize: 20,
};

export interface SampleRow {
  /** Primary key of the affected row, so the user can identify the record. */
  readonly key: Record<string, unknown>;
  /** Null for INSERT — the row did not exist. */
  readonly before: Row | null;
  /** Null for DELETE — the row will not exist. */
  readonly after: Row | null;
  /** Columns whose value differs between before and after. */
  readonly changed: readonly string[];
}

export interface Sample {
  readonly rows: readonly SampleRow[];
  /** Total rows affected, which is usually far larger than `rows.length`. */
  readonly totalAffected: number;
  /**
   * How many of the sampled rows actually differ before versus after.
   *
   * This is not the same as `rows.length`. `UPDATE users SET tier = 'free'
   * WHERE tier IS NOT NULL` rewrites every row, and Postgres counts every one
   * of them as affected, but a row already holding 'free' does not change
   * value. Saying "50,000 rows change" above twenty visibly identical rows
   * reads as a bug in the tool, so the difference is measured and said out
   * loud instead.
   */
  readonly changedInSample?: number;
  /**
   * Set when no sample could be taken. The count is still exact; only the
   * per-row detail is missing. A wrong sample is worse than no sample, so
   * this is stated rather than approximated.
   */
  readonly unavailable?: string;
}

/**
 * One row in the panel.
 *
 * `headline` is the badge text and `detail` is the sentence under it. Both are
 * written here rather than in the webview, because the wording depends on the
 * measured numbers and the webview should not be doing arithmetic.
 */
export interface Finding {
  readonly statementIndex: number;
  readonly kind: StatementKind;
  readonly classification: Classification;
  readonly severity: Severity;
  readonly headline: string;
  readonly detail: string;
  /** Exact, when known. */
  readonly rowCount?: number;
  /**
   * Total rows in the target table, so `rowCount` can be drawn as a share of
   * the whole rather than left as a bare number. "40,072 rows" means nothing
   * until you know whether the table holds fifty thousand or fifty million.
   *
   * This is the planner's estimate from the catalog, not a COUNT(*) — it is
   * free, and it only ever drives the width of a bar.
   */
  readonly tableRows?: number;
  readonly sample?: Sample;
  /** The query plan, when plan capture is turned on and it succeeded. */
  readonly plan?: AnalysedPlan;
  /** Which lock the statement takes, and what that blocks. */
  readonly lock?: LockProfile;
  /**
   * Sessions that would make this statement wait — and therefore make
   * everything arriving after it wait too. Empty is the common case and the
   * one worth saying nothing about.
   */
  readonly queuedBehind?: readonly Blocker[];
  /** What a delete would take with it through ON DELETE CASCADE. */
  readonly cascade?: CascadeNode;
  /**
   * True when any number in `detail` is an estimate rather than a measurement.
   * The panel renders these differently — an estimate must never carry the
   * visual weight of a measured fact.
   */
  readonly estimated?: boolean;
  /** Set when the probe failed; the row shows as "couldn't analyze". */
  readonly error?: string;
}

/** What the panel is told about one statement, before and after analysis. */
export interface PanelStatement {
  readonly index: number;
  readonly sql: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface PanelState {
  readonly file: string;
  readonly connection: string;
  readonly statements: readonly PanelStatement[];
  readonly findings: Readonly<Record<number, Finding>>;
  readonly done: boolean;
}
