import { Classification, StatementKind } from '../parser/classifier';
import { Row } from '../adapters/types';

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
  readonly sample?: Sample;
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
