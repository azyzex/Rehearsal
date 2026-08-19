import { Severity, Thresholds } from './types';

/**
 * Severity is computed from measured numbers, never from the text of the
 * statement (spec §7).
 *
 * That distinction is the whole difference between Dry Run and a linter. A
 * linter sees `DROP COLUMN` and warns. Dry Run counts the column first, and if
 * nothing is in it, says so: `safe`. Getting that case right is what makes the
 * red rows worth believing — a tool that cries wolf gets switched off, and then
 * it is not there on the day it would have mattered.
 */

export const SEVERITY_ORDER: readonly Severity[] = ['safe', 'caution', 'blocking', 'destructive'];

export function worst(severities: readonly Severity[]): Severity {
  return severities.reduce<Severity>(
    (acc, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(acc) ? s : acc),
    'safe',
  );
}

/** Rows that lose data permanently. */
export function dataLossSeverity(rowsLosingData: number): Severity {
  return rowsLosingData > 0 ? 'destructive' : 'safe';
}

/** Rows that make a statement fail outright. */
export function violationSeverity(violatingRows: number): Severity {
  return violatingRows > 0 ? 'blocking' : 'safe';
}

/**
 * An UPDATE or DELETE that succeeds, judged purely on how much of the table it
 * moves. A statement with no WHERE clause at all is treated as destructive
 * regardless of count, because that is a different kind of mistake from one
 * that simply matches a lot of rows.
 */
export function blastRadiusSeverity(
  rowsAffected: number,
  hasWhere: boolean,
  thresholds: Thresholds,
): Severity {
  if (!hasWhere && rowsAffected > 0) {
    return 'destructive';
  }
  if (rowsAffected === 0) {
    return 'safe';
  }
  if (rowsAffected > thresholds.destructiveRows) {
    return 'destructive';
  }
  if (rowsAffected > thresholds.cautionRows) {
    return 'caution';
  }
  return 'safe';
}

/**
 * An index build. The cost is the lock, not the index, so CONCURRENTLY is the
 * only thing that really matters — and on a small table even a plain build is
 * over before anyone notices.
 */
export function indexBuildSeverity(
  tableRows: number,
  concurrently: boolean,
  thresholds: Thresholds,
): Severity {
  if (concurrently) {
    return 'safe';
  }
  return tableRows > thresholds.largeTable ? 'blocking' : 'caution';
}

/** Rough build time for an index, in seconds. Always presented as an estimate. */
export function estimateIndexBuildSeconds(tableRows: number): number {
  // Around 250k rows/second for a simple btree on commodity hardware. This is
  // deliberately a single crude constant: the number exists to convey an order
  // of magnitude ("seconds" versus "minutes"), and dressing it up with more
  // arithmetic would imply a precision it does not have.
  return Math.max(1, Math.round(tableRows / 250_000));
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
