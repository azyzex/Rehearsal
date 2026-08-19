import { DatabaseAdapter } from '../adapters/types';
import { classify, Classification, StatementKind } from '../parser/classifier';
import { SplitStatement } from '../parser/splitter';
import { analyzeDdl } from './ddl';
import { analyzeDml } from './dml';
import { blastRadiusSeverity, formatCount, plural } from './severity';
import { Finding, Thresholds } from './types';

/**
 * Runs each statement through the right analyzer and turns the result into a
 * panel row.
 *
 * Findings are emitted one at a time through `onFinding` rather than returned
 * as a batch, because the panel resolves rows independently (spec §9): a slow
 * count on a large table must not hold up every other row in the file.
 *
 * Statements are still analysed in order, one at a time, because the adapter
 * holds a single connection. The independence is in the *rendering*, not in
 * the concurrency.
 */

const DML_KINDS: ReadonlySet<StatementKind> = new Set(['update', 'delete', 'insert']);

export interface AnalyzeOptions {
  readonly adapter: DatabaseAdapter;
  readonly statements: readonly SplitStatement[];
  readonly thresholds: Thresholds;
  readonly onFinding: (finding: Finding) => void;
  readonly isCancelled?: () => boolean;
}

export async function analyzeStatements(options: AnalyzeOptions): Promise<void> {
  const { adapter, statements, thresholds, onFinding, isCancelled } = options;

  for (const statement of statements) {
    if (isCancelled?.()) {
      return;
    }

    const classification = classify(statement.sql);

    try {
      onFinding(await analyzeOne(adapter, statement, classification, thresholds));
    } catch (error) {
      onFinding({
        statementIndex: statement.index,
        kind: classification.kind,
        classification,
        severity: 'caution',
        headline: "Couldn't analyze",
        detail: describeError(error),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function analyzeOne(
  adapter: DatabaseAdapter,
  statement: SplitStatement,
  classification: Classification,
  thresholds: Thresholds,
): Promise<Finding> {
  const base = {
    statementIndex: statement.index,
    kind: classification.kind,
    classification,
  };

  if (DML_KINDS.has(classification.kind)) {
    const { rowCount, sample } = await analyzeDml(
      adapter,
      statement.sql,
      classification,
      thresholds,
    );

    const severity = blastRadiusSeverity(
      rowCount,
      classification.hasWhere !== false,
      thresholds,
    );

    return {
      ...base,
      severity,
      ...describeDml(classification, rowCount, severity === 'destructive'),
      rowCount,
      sample,
    };
  }

  if (classification.kind === 'select' || classification.kind === 'other') {
    return {
      ...base,
      severity: 'safe',
      headline: classification.kind === 'select' ? 'Reads only' : 'Not analysed',
      detail:
        classification.kind === 'select'
          ? 'This statement only reads. It changes nothing.'
          : 'Dry Run does not recognise this statement, so nothing was measured. Treat it as unknown rather than safe.',
    };
  }

  const outcome = await analyzeDdl(adapter, classification, thresholds);
  return {
    ...base,
    severity: outcome.severity,
    headline: outcome.headline,
    detail: outcome.detail,
    ...(outcome.rowCount !== undefined ? { rowCount: outcome.rowCount } : {}),
    ...(outcome.estimated ? { estimated: true } : {}),
  };
}

/**
 * The sentence under the badge. It leads with the number, because the number is
 * the reason the row exists — "40,182 rows have a value here", never "this may
 * affect data".
 */
function describeDml(
  classification: Classification,
  rowCount: number,
  severe: boolean,
): { headline: string; detail: string } {
  const rows = `${formatCount(rowCount)} ${plural(rowCount, 'row')}`;
  const table = classification.table ?? 'the table';
  const noWhere = classification.hasWhere === false;

  if (rowCount === 0) {
    return {
      headline: 'Safe',
      detail: 'This matches no rows at all. Nothing changes.',
    };
  }

  switch (classification.kind) {
    case 'delete':
      if (noWhere) {
        return {
          headline: 'Will destroy data',
          detail: `Deletes every row in ${table} — all ${rows}. There is no WHERE clause.`,
        };
      }
      return {
        headline: severe ? 'Will destroy data' : 'Deletes rows',
        detail: `${rows} ${plural(rowCount, 'is', 'are')} deleted from ${table}.`,
      };

    case 'insert':
      return {
        headline: 'Adds rows',
        detail: `${rows} ${plural(rowCount, 'is', 'are')} inserted into ${table}.`,
      };

    case 'update':
    default:
      if (noWhere) {
        return {
          headline: 'Will change every row',
          detail: `Updates every row in ${table} — all ${rows}. There is no WHERE clause.`,
        };
      }
      return {
        headline: severe ? 'Changes a lot of rows' : 'Changes rows',
        detail: `${rows} in ${table} ${plural(rowCount, 'changes', 'change')}.`,
      };
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // The common Postgres failures, said in a way that points at the fix.
  if (/relation .* does not exist/i.test(message)) {
    return `${message}. If an earlier statement in this file creates it, remember that previews never commit, so it does not exist yet.`;
  }
  if (/permission denied/i.test(message)) {
    return `${message}. The connected user cannot read this table, so nothing could be measured.`;
  }
  if (/canceling statement due to statement timeout/i.test(message)) {
    return 'The probe took longer than the configured statement timeout, so it was cancelled. Nothing was changed.';
  }
  if (/canceling statement due to lock timeout/i.test(message)) {
    return 'Another session holds a lock on this table, so the probe gave up rather than join the queue. Nothing was changed.';
  }
  return message;
}
