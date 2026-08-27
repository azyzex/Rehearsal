import { DatabaseAdapter } from '../adapters/types';
import { CloneRunner, measureOnClone } from '../adapters/mysqlClone';
import { Classification } from '../parser/classifier';
import {
  blastRadiusSeverity,
  dataLossSeverity,
  estimateIndexBuildSeconds,
  formatBytes,
  formatCount,
  formatDuration,
  indexBuildSeverity,
  plural,
  worst,
  violationSeverity,
} from './severity';
import { Finding, Severity, Thresholds } from './types';

/**
 * DDL analysis: probe, never execute.
 *
 * Not even inside a rolled-back transaction. An index build takes its full time
 * and its full lock whether it is committed or not, so "previewing" it would
 * cause exactly the outage the preview exists to prevent. Everything here is a
 * read-only counting query against the data as it is right now.
 *
 * Every number these produce is exact except the index build time, which is
 * labelled as an estimate wherever it appears.
 */

export interface DdlOutcome {
  readonly severity: Severity;
  readonly headline: string;
  readonly detail: string;
  readonly rowCount?: number;
  readonly estimated?: boolean;
}

export async function analyzeDdl(
  adapter: DatabaseAdapter,
  classification: Classification,
  thresholds: Thresholds,
  sql?: string,
): Promise<DdlOutcome> {
  const counted = await countDdl(adapter, classification, thresholds);
  return confirmOnCopy(adapter, classification, thresholds, sql, counted);
}

/**
 * The counted answer: what the probes say without running anything.
 *
 * This is the answer on every engine, and the only one on two of them. On
 * MySQL it can be confirmed by actually running the statement against a copy —
 * see `confirmOnCopy` below — but it is never replaced by something weaker.
 */
async function countDdl(
  adapter: DatabaseAdapter,
  classification: Classification,
  thresholds: Thresholds,
): Promise<DdlOutcome> {
  const { kind, table, column } = classification;
  // CONCURRENTLY is a Postgres keyword. Recommending it to a MySQL user costs
  // them the time to try it and the trust they had in the rest of the row.
  const online = onlineIndexAdvice(adapter.engine);

  switch (kind) {
    case 'drop_column': {
      const affected = await adapter.countNonNull(table!, column!);
      const total = await adapter.countRows(table!);
      if (affected === 0) {
        return {
          severity: 'safe',
          headline: 'Safe',
          detail: `${column} is empty in all ${formatCount(total)} ${plural(total, 'row')}. Nothing is lost.`,
          rowCount: 0,
        };
      }
      return {
        severity: dataLossSeverity(affected),
        headline: 'Will destroy data',
        detail: `${formatCount(affected)} ${plural(affected, 'row')} ${plural(affected, 'has', 'have')} a value in ${column}. Dropping it cannot be undone.`,
        rowCount: affected,
      };
    }

    case 'drop_table':
    case 'truncate': {
      const rows = await adapter.countRows(table!);
      const verb = kind === 'truncate' ? 'Truncating' : 'Dropping';
      if (rows === 0) {
        return {
          severity: 'safe',
          headline: 'Safe',
          detail: `${table} is empty.`,
          rowCount: 0,
        };
      }
      return {
        severity: 'destructive',
        headline: 'Will destroy data',
        detail: `${verb} ${table} loses all ${formatCount(rows)} ${plural(rows, 'row')}. Cannot be undone.`,
        rowCount: rows,
      };
    }

    case 'set_not_null': {
      // Counted as "every row, minus the ones with a value", rather than with a
      // `column IS NULL` predicate.
      //
      // That predicate had to quote the column name, and it quoted it the ANSI
      // way. MySQL's default sql_mode reads `"email"` as the string 'email',
      // not as a column, so `WHERE "email" IS NULL` asks whether a constant is
      // null — always false. The count came back 0 and the panel said "every
      // row already has a value in email. This will apply cleanly." about a
      // statement that fails against twelve rows.
      //
      // Telling someone a migration is safe when it will fail is the worst
      // wrong answer this extension can give, so the raw predicate is gone:
      // `countRows` and `countNonNull` both quote for their own engine, and
      // neither takes SQL from here.
      const total = await adapter.countRows(table!);
      const nulls = total - (await adapter.countNonNull(table!, column!));
      if (nulls === 0) {
        return {
          severity: 'safe',
          headline: 'Safe',
          // "a ${column}" produces "a email" as often as "a phone", and the
          // article cannot be chosen without knowing the word. Sidestepped.
          detail: `Every row already has a value in ${column}. This will apply cleanly.`,
          rowCount: 0,
        };
      }
      return {
        severity: violationSeverity(nulls),
        headline: 'Will fail',
        detail: `${formatCount(nulls)} ${plural(nulls, 'row')} ${plural(nulls, 'has', 'have')} no ${column}. The migration stops here, partway applied.`,
        rowCount: nulls,
      };
    }

    case 'drop_not_null':
      return {
        severity: 'safe',
        headline: 'Safe',
        detail: 'Relaxing a constraint cannot fail and loses no data.',
      };

    case 'alter_column_type': {
      const failures = await adapter.countCastFailures(table!, column!, classification.newType!);
      const total = await adapter.countRows(table!);

      if (failures === null) {
        return {
          severity: 'caution',
          headline: 'Cannot verify',
          detail: `Postgres would not test this cast without running it, so the ${formatCount(total)}-row conversion is unchecked. Expect a full table rewrite, and a lock for its duration.`,
          rowCount: total,
          estimated: true,
        };
      }
      if (failures > 0) {
        return {
          severity: 'blocking',
          headline: 'Will fail',
          detail: `${formatCount(failures)} ${plural(failures, 'row')} cannot be converted to ${classification.newType}.`,
          rowCount: failures,
        };
      }
      return {
        severity: 'caution',
        headline: 'Rewrites the table',
        detail: `All ${formatCount(total)} ${plural(total, 'row')} convert cleanly, but the table is rewritten and locked while it happens.`,
        rowCount: total,
      };
    }

    case 'add_check': {
      if (!classification.checkPredicate) {
        return unanalysable('the CHECK expression could not be read');
      }
      const violations = await adapter.countViolating(table!, classification.checkPredicate);
      if (violations === 0) {
        return {
          severity: 'safe',
          headline: 'Safe',
          detail: 'Every row already satisfies this constraint.',
          rowCount: 0,
        };
      }
      return {
        severity: violationSeverity(violations),
        headline: 'Will fail',
        detail: `${formatCount(violations)} ${plural(violations, 'row')} ${plural(violations, 'violates', 'violate')} this constraint.`,
        rowCount: violations,
      };
    }

    case 'add_foreign_key': {
      const reference = classification.references;
      if (!reference || !classification.columns?.length) {
        return unanalysable('the foreign key columns could not be read');
      }
      const orphans = await adapter.countOrphans(
        table!,
        classification.columns,
        reference.table,
        reference.columns,
      );
      const column = classification.columns.join(', ');
      if (orphans === 0) {
        return {
          severity: 'safe',
          headline: 'Safe',
          detail: `Every ${column} already matches a row in ${reference.table}.`,
          rowCount: 0,
        };
      }
      return {
        severity: violationSeverity(orphans),
        headline: 'Will fail',
        // Phrased without an article before the column name: "a org_id" and
        // "an user_id" are both wrong, and the article depends on data.
        detail: `${formatCount(orphans)} ${plural(orphans, 'row')} in ${table} reference ${column} values that are not in ${reference.table}.`,
        rowCount: orphans,
      };
    }

    case 'add_unique': {
      if (!classification.columns?.length) {
        return unanalysable('the unique columns could not be read');
      }
      const { groups, rows } = await adapter.countDuplicates(table!, classification.columns);
      if (groups === 0) {
        return {
          severity: 'safe',
          headline: 'Safe',
          detail: `${classification.columns.join(', ')} is already unique across the table.`,
          rowCount: 0,
        };
      }
      return {
        severity: 'blocking',
        headline: 'Will fail',
        detail: `${formatCount(rows)} ${plural(rows, 'row')} share a duplicate ${classification.columns.join(', ')}, across ${formatCount(groups)} ${plural(groups, 'value')}.`,
        rowCount: rows,
      };
    }

    case 'create_index': {
      const stats = await adapter.tableStats(table!);
      const rows = stats.estimatedRows;
      const severity = indexBuildSeverity(rows, classification.concurrently === true, thresholds);

      if (classification.concurrently) {
        return {
          severity: 'safe',
          headline: 'Safe',
          detail: `Built without blocking writes on ${formatCount(rows)} ${plural(rows, 'row')} (${formatBytes(stats.totalBytes)}), so writes keep working throughout.`,
          rowCount: rows,
          estimated: true,
        };
      }

      const seconds = estimateIndexBuildSeconds(rows);
      return {
        severity,
        headline: severity === 'blocking' ? 'Will lock the table' : 'Locks the table briefly',
        detail: `${table} has about ${formatCount(rows)} ${plural(rows, 'row')} (${formatBytes(stats.totalBytes)}). Writes are blocked for roughly ${formatDuration(seconds)}.${online}`,
        rowCount: rows,
        estimated: true,
      };
    }

    case 'rename_column':
    case 'rename_table':
      return {
        severity: 'caution',
        headline: 'May break your code',
        detail:
          kind === 'rename_column'
            ? `The data is untouched, but anything still reading ${column} breaks the moment this lands.`
            : `The data is untouched, but anything still reading ${table} breaks the moment this lands.`,
      };

    case 'add_column':
      return {
        severity: 'safe',
        headline: 'Safe',
        detail: 'Adding a nullable column touches no existing rows.',
      };

    case 'create_table':
      return {
        severity: 'safe',
        headline: 'Safe',
        detail: 'Creating a table affects no existing data.',
      };

    default:
      return unanalysable(`Dry Run does not analyse this kind of statement yet`);
  }
}

/** Used for statements whose shape was recognised but whose detail was not. */
function unanalysable(reason: string): DdlOutcome {
  return {
    severity: 'caution',
    headline: 'Not analysed',
    detail: `${capitalize(reason)}. Nothing was measured, so treat this row as unknown rather than safe.`,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Quotes a column name for use inside a WHERE fragment. */
export { blastRadiusSeverity, type Finding };


/**
 * How to build an index without taking the table down, per engine.
 *
 * Every database has an answer and none of them share a keyword, so the
 * sentence has to know which one it is talking about. An empty string where
 * there is no good answer, rather than a suggestion that does not run.
 */
function onlineIndexAdvice(engine: string): string {
  switch (engine) {
    case 'postgres':
      return ' Adding CONCURRENTLY avoids the lock entirely.';
    case 'mysql':
      // The default since 5.6 for most index types, but not for all of them,
      // and stating it explicitly is what makes the build fail loudly rather
      // than silently locking the table when it cannot.
      return ' Adding ALGORITHM=INPLACE, LOCK=NONE builds it without blocking writes, ' +
        'and fails outright if this index cannot be built that way.';
    case 'mongo':
      return ' MongoDB builds indexes in the background by default and does not block ' +
        'writes for this.';
    case 'sqlite':
      // There is no online build and no way to ask for one. What there is
      // instead is a database that is a file on one machine, so the lock is
      // held against whatever else has it open rather than against traffic.
      return ' SQLite has no online index build; the write lock is held for the ' +
        'whole build, against anything else with the file open.';
    default:
      return '';
  }
}

/**
 * Runs the statement against a copy of the table, and folds in what happened.
 *
 * Only on MySQL, only when asked for, and only ever in one direction: a copy
 * that *fails* is definitive and takes over, and a copy that *succeeds* adds a
 * sentence without softening anything.
 *
 * That asymmetry is not caution for its own sake. `CREATE TABLE … LIKE` does
 * not copy foreign keys, so the copy has none to violate — a statement whose
 * real failure would be a foreign key failure succeeds against it. Letting a
 * success downgrade a blocking finding would turn exactly that case green.
 */
async function confirmOnCopy(
  adapter: DatabaseAdapter,
  classification: Classification,
  thresholds: Thresholds,
  sql: string | undefined,
  counted: DdlOutcome,
): Promise<DdlOutcome> {
  if (!thresholds.cloneTables || adapter.engine !== 'mysql' || !sql || !classification.table) {
    return counted;
  }

  const runner = adapter as unknown as CloneRunner;
  if (typeof runner.cloneExec !== 'function') {
    return counted;
  }

  const measured = await measureOnClone(runner, classification.table, sql, {
    rowCeiling: thresholds.cloneRowLimit,
  }).catch(() => undefined);

  if (!measured?.ran) {
    return counted;
  }

  if (measured.succeeded === false) {
    // The server's own words, which name the value the count could only total.
    return {
      ...counted,
      severity: worst([counted.severity, 'blocking']),
      headline: 'Will fail',
      detail:
        `${counted.detail} Run against a copy of the table, MySQL refused it: ` +
        `${measured.error}`,
      estimated: false,
    };
  }

  const warned = (measured.warnings ?? []).filter(
    (warning) => !/^Note/i.test(warning) && warning.trim().length > 0,
  );

  if (warned.length > 0) {
    // Succeeding with warnings is the quiet case: MySQL applied the change and
    // changed the data to make it fit. Worth more than a green row.
    return {
      ...counted,
      severity: worst([counted.severity, 'caution']),
      detail:
        `${counted.detail} Run against a copy it succeeded, with warnings: ` +
        `${warned.slice(0, 3).join(' ')}`,
      estimated: false,
    };
  }

  return {
    ...counted,
    detail:
      `${counted.detail} Run against a copy of all ` +
      `${formatCount(measured.rows ?? 0)} ${plural(measured.rows ?? 0, 'row')}, it succeeded` +
      `${typeof measured.milliseconds === 'number' ? ` in ${measured.milliseconds}ms` : ''}.`,
    estimated: false,
  };
}
