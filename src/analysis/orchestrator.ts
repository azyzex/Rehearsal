import { CascadeNode, DatabaseAdapter } from '../adapters/types';
import { classify, Classification, StatementKind } from '../parser/classifier';
import { maskLiterals } from '../parser/mask';
import { SplitStatement } from '../parser/splitter';
import { cascadeTotal, describeCascade } from './cascade';
import { analyzeDdl } from './ddl';
import { analyzeDml } from './dml';
import { Blocker, LockProfile, lockProfileFor, wouldQueue } from './locks';
import { rewritesFor } from './rewrite';
import { blastRadiusSeverity, formatCount, plural, worst } from './severity';
import { Finding, Sample, Thresholds } from './types';

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

  // Table sizes are looked up once per run, not once per statement: a
  // migration usually hits the same two or three tables repeatedly, and this
  // is a network round trip each time.
  const tableSizes = new Map<string, number | undefined>();
  const sizeOf = async (table: string | undefined): Promise<number | undefined> => {
    if (!table) {
      return undefined;
    }
    if (!tableSizes.has(table)) {
      tableSizes.set(
        table,
        await adapter
          .tableStats(table)
          .then((stats) => stats.estimatedRows)
          .catch(() => undefined),
      );
    }
    return tableSizes.get(table);
  };

  // Who holds a lock on each table, read once per run. Asking per statement
  // would be both slower and less coherent: a migration is previewed as a
  // whole, and the answer changing halfway through would be noise.
  const blockerCache = new Map<string, readonly Blocker[]>();

  for (const statement of statements) {
    if (isCancelled?.()) {
      return;
    }

    const classification = classify(statement.sql);

    try {
      const finding = await analyzeOne(adapter, statement, classification, thresholds);
      const tableRows = await sizeOf(classification.table);

      // The lock outlook is separate from what the statement does to the data,
      // and it is the half that turns a one-second migration into an outage.
      const outlook = await lockOutlook(adapter, classification, blockerCache);

      const withContext: Finding = {
        ...finding,
        ...(tableRows === undefined ? {} : { tableRows }),
        ...outlook,
        ...(outlook.queuedBehind && outlook.queuedBehind.length > 0
          ? { severity: worst([finding.severity, 'blocking']) }
          : {}),
      };

      // Rewrites are computed from the finished finding, because what to
      // suggest depends on what was measured rather than on the statement.
      const rewrites = rewritesFor(withContext);
      onFinding(rewrites.length > 0 ? { ...withContext, rewrites } : withContext);
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
    const { rowCount, sample, plan } = await analyzeDml(
      adapter,
      statement.sql,
      classification,
      thresholds,
      statement.params ?? [],
    );

    const severity = blastRadiusSeverity(
      rowCount,
      classification.hasWhere !== false,
      thresholds,
    );

    const described = describeDml(classification, rowCount, severity === 'destructive');

    // What a delete takes with it that the statement never names.
    const cascade =
      classification.kind === 'delete' && rowCount > 0
        ? await cascadeFor(adapter, classification, statement)
        : undefined;

    return {
      ...base,
      severity: cascade && cascadeTotal(cascade) > 0 ? worst([severity, 'destructive']) : severity,
      ...described,
      detail:
        described.detail +
        noOpRewriteNote(classification, sample) +
        describeCascade(cascade),
      rowCount,
      sample,
      ...(plan ? { plan } : {}),
      ...(cascade ? { cascade } : {}),
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
 * An UPDATE can touch a row without changing it — `SET tier = 'free' WHERE tier
 * IS NOT NULL` rewrites rows that already hold 'free'. Postgres counts those as
 * affected, correctly, but a panel that says "50,000 rows change" above twenty
 * visibly identical rows looks broken. So when none of the sample actually
 * differs, the row says so.
 *
 * That is worth knowing on its own: a rewrite of the whole table still costs the
 * same I/O, bloat and replication traffic as a real one.
 */
function noOpRewriteNote(classification: Classification, sample: Sample): string {
  if (classification.kind !== 'update' || !sample.rows.length) {
    return '';
  }
  if (sample.changedInSample !== 0) {
    return '';
  }
  return sample.rows.length === sample.totalAffected
    ? ' None of them actually change value — this rewrites the rows without altering them.'
    : ` None of the ${sample.rows.length} sampled rows actually change value, so this may be rewriting rows without altering them.`;
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
        detail: `${rows} in ${table} ${plural(rowCount, 'is', 'are')} updated.`,
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

/**
 * Which lock this statement takes, and whether anything is in its way.
 *
 * The second half is the one that matters and the one nothing else reports.
 * Postgres queues lock requests fairly: a DDL statement waiting behind a
 * long-running reader does not just wait itself, it becomes the head of a queue
 * that every subsequent query joins — including reads that conflict with
 * nothing. That is how a routine ADD COLUMN takes a site down.
 *
 * A failure here is not a failure of the preview. `pg_stat_activity` may be
 * restricted on a managed database, and the measurements are worth having
 * without it, so this degrades to saying nothing rather than to an error.
 */
async function lockOutlook(
  adapter: DatabaseAdapter,
  classification: Classification,
  cache: Map<string, readonly Blocker[]>,
): Promise<{ lock?: LockProfile; queuedBehind?: readonly Blocker[] }> {
  const profile = lockProfileFor(classification.kind, {
    concurrently: classification.concurrently === true,
  });

  const table = classification.table;
  if (!table || profile.level === 'NONE') {
    return { lock: profile };
  }

  if (!cache.has(table)) {
    cache.set(
      table,
      await adapter
        .lockHolders(table)
        .then((holders) =>
          holders.map((holder) => ({
            pid: holder.pid,
            state: holder.state,
            applicationName: holder.applicationName,
            query: holder.query,
            seconds: holder.seconds,
            lockMode: holder.lockMode,
          })),
        )
        .catch(() => []),
    );
  }

  const queued = wouldQueue(profile, cache.get(table) ?? []);
  return { lock: profile, ...(queued.length > 0 ? { queuedBehind: queued } : {}) };
}

/**
 * The cascade a delete would set off.
 *
 * Needs the statement's WHERE clause to know which rows are going, so it only
 * runs where that can be recovered: a generated `delete_row` carries bound
 * parameters and an unambiguous predicate, and a hand-written DELETE has its
 * predicate as text after the WHERE keyword.
 *
 * A failure is silent by design. The row count beside it is already correct and
 * measured; a missing cascade makes the row less complete, not wrong.
 */
async function cascadeFor(
  adapter: DatabaseAdapter,
  classification: Classification,
  statement: SplitStatement,
): Promise<CascadeNode | undefined> {
  const table = classification.table;
  if (!table) {
    return undefined;
  }

  const predicate = whereClauseOf(statement.sql);
  if (predicate === undefined) {
    return undefined;
  }

  return adapter
    .cascadeImpact(table, predicate, statement.params ?? [])
    .catch(() => undefined);
}

/**
 * The text after a top-level WHERE, or `true` when there is none.
 *
 * Matching on the masked copy so a WHERE inside a string or a subquery is not
 * mistaken for the statement's own. Anything with a USING or RETURNING clause
 * is declined rather than guessed at — a predicate that is subtly wrong would
 * produce a cascade count that is confidently wrong, which is worse than none.
 */
function whereClauseOf(sql: string): string | undefined {
  const masked = maskLiterals(sql);

  if (/\b(using|returning)\b/i.test(masked)) {
    return undefined;
  }

  const match = /\bwhere\b/i.exec(masked);
  if (!match) {
    return 'true'; // no WHERE: every row goes
  }

  const predicate = sql.slice(match.index + match[0].length).replace(/;\s*$/, '').trim();
  return predicate.length > 0 ? predicate : undefined;
}
