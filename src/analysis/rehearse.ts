import type { Rehearsal, RehearsalInput } from '../adapters/postgresRehearsal';
import { SchemaSnapshot } from '../adapters/types';
import { maskLiterals } from '../parser/mask';
import { StatementLanguage } from '../parser/language';
import { SplitStatement } from '../parser/splitter';
import { formatCount } from './severity';
import { lockProfileFor } from './locks';
import { classify } from '../parser/classifier';

/**
 * Which tables to copy, and which statements can be run against the copies.
 *
 * A statement is run only when it cannot reach an original. Unqualified names
 * resolve to the copies once the search path points at them, so the danger is
 * a name that says which schema it means — `public.orders` would be the real
 * table. Those are skipped and said to be, rather than guessed at.
 */
export function planRehearsal(
  statements: readonly SplitStatement[],
  language: StatementLanguage,
  snapshot: SchemaSnapshot,
): RehearsalInput & { rows: number } {
  const known = new Map(snapshot.tables.map((table) => [table.name.toLowerCase(), table]));
  const schemas = snapshot.schemas.map((schema) => schema.toLowerCase());
  const tables = new Map<string, number>();

  const planned = statements.map((statement) => {
    const classification = language.classify(statement.sql);
    const masked = maskLiterals(statement.sql);

    for (const name of [classification.table, classification.references?.table]) {
      const table = name ? known.get(bareName(name).toLowerCase()) : undefined;
      if (table) {
        // Qualified, so a table outside the default schema is copied from
        // where it really lives.
        tables.set(table.qualified, table.rows);
      }
    }

    let skip: string | undefined;
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\b/i.test(masked)) {
      skip = 'Transaction control. The rehearsal is one transaction already.';
    } else if (/\bCONCURRENTLY\b/i.test(masked)) {
      skip =
        'CONCURRENTLY cannot run inside a transaction. Its lock is the weak one ' +
        'anyway: writes keep working while it builds.';
    } else if (
      schemas.some((schema) => new RegExp(`(^|[^\\w"])"?${escape(schema)}"?\\s*\\.`, 'i').test(masked))
    ) {
      skip =
        'It names a schema explicitly, so it would reach the real table rather than ' +
        'the copy. Remove the schema name to rehearse it.';
    }

    return {
      index: statement.index,
      sql: statement.sql,
      ...(statement.params ? { params: statement.params } : {}),
      ...(skip ? { skip } : {}),
    };
  });

  return {
    tables: [...tables.keys()],
    statements: planned,
    rows: [...tables.values()].reduce((sum, rows) => sum + rows, 0),
  };
}

/** The rehearsal as a document: what ran, how long each took, where it stopped. */
export function rehearsalReport(
  rehearsal: Rehearsal,
  statements: readonly SplitStatement[],
  options: { file: string; connection: string },
): string {
  const lines = [
    '# Rehearsal on a copy',
    '',
    `**File:** ${options.file}  `,
    `**Database:** ${options.connection}`,
    '',
  ];

  if (!rehearsal.ran) {
    lines.push(String(rehearsal.skipped), '');
    return lines.join('\n');
  }

  const copied = rehearsal.copied
    .map((entry) => `${entry.table} (${formatCount(entry.rows)} rows)`)
    .join(', ');
  lines.push(
    `Copied ${copied || 'nothing'} in ${formatMs(rehearsal.copyMilliseconds)}, ran every ` +
      'statement against the copies for real, then rolled everything back. The originals ' +
      'were only ever read.',
    '',
    '| Line | Statement | Result | Time |',
    '| ---: | --- | --- | ---: |',
  );

  let total = 0;
  let longest: { index: number; ms: number } | undefined;

  for (const result of rehearsal.statements) {
    const statement = statements.find((candidate) => candidate.index === result.index);
    const sql = (statement?.sql ?? '').replace(/\s+/g, ' ').slice(0, 70).replace(/\|/g, '\\|');
    const line = statement ? statement.startLine + 1 : '';
    const time = result.milliseconds === undefined ? '' : formatMs(result.milliseconds);
    const outcome =
      result.status === 'ran'
        ? 'ran'
        : result.status === 'failed'
          ? `**failed**: ${String(result.error).replace(/\|/g, '\\|')}`
          : result.status === 'skipped'
            ? `skipped: ${result.reason}`
            : 'not reached';

    lines.push(`| ${line} | \`${sql}\` | ${outcome} | ${time} |`);

    if (result.milliseconds !== undefined) {
      total += result.milliseconds;
      if (!longest || result.milliseconds > longest.ms) {
        longest = { index: result.index, ms: result.milliseconds };
      }
    }
  }

  lines.push('');

  const failed = rehearsal.statements.find((result) => result.status === 'failed');
  if (failed) {
    const statement = statements.find((candidate) => candidate.index === failed.index);
    lines.push(
      `**It stops at line ${statement ? statement.startLine + 1 : '?'}.** A migration halts at ` +
        'its first failure, so nothing after it ran — here or, if you apply it, for real.',
      '',
    );
  }

  if (longest) {
    const statement = statements.find((candidate) => candidate.index === longest!.index);
    lines.push(
      `In total the statements took ${formatMs(total)}. The longest, at line ` +
        `${statement ? statement.startLine + 1 : '?'}, took ${formatMs(longest.ms)} — for a ` +
        'statement that takes an exclusive lock, that is how long every read and write on ' +
        'the table would wait.',
      '',
    );
  }

  if (rehearsal.queries && rehearsal.queries.length > 0) {
    lines.push(
      '## What it does to the busiest queries on these tables',
      '',
      'From pg_stat_statements, planned on the copies before and after the migration. Costs',
      'are the planner\'s units, not milliseconds: what matters is the ratio, and whether the',
      'plan changed.',
      '',
      '| Query | Before | After | Plan |',
      '| --- | ---: | ---: | --- |',
    );
    for (const query of rehearsal.queries) {
      const text = query.query.replace(/\s+/g, ' ').slice(0, 60).replace(/\|/g, '\\|');
      if (!query.before || !query.after) {
        lines.push(`| \`${text}\` | | | could not be planned: ${String(query.unplanned).slice(0, 80)} |`);
        continue;
      }
      const ratio = query.after.cost / Math.max(query.before.cost, 0.01);
      const change =
        ratio < 0.8
          ? `**${Math.round(1 / ratio)}× cheaper**`
          : ratio > 1.25
            ? `**${ratio.toFixed(1)}× dearer**`
            : 'about the same';
      const before = query.before.scans.join(', ');
      const after = query.after.scans.join(', ');
      const plan = before === after ? change : `${change}: ${before || '—'} → ${after || '—'}`;
      lines.push(
        `| \`${text}\` | ${Math.round(query.before.cost).toLocaleString()} | ` +
          `${Math.round(query.after.cost).toLocaleString()} | ${plan} |`,
      );
    }
    lines.push('');
  } else if (rehearsal.queriesSkipped) {
    lines.push(`_${rehearsal.queriesSkipped}_`, '');
  }

  lines.push(...queueSection(rehearsal, statements));

  lines.push(
    '---',
    '',
    'These are real timings at this database\'s size, on a copy with no traffic. A copy has',
    'no queue, so a statement that would wait behind a long transaction in production runs',
    'straight through here: the preview\'s lock check is what answers that. Foreign keys are',
    'not copied, so a statement whose only failure would be a foreign key violation succeeds',
    'here.',
    '',
  );

  return lines.join('\n');
}

/**
 * Who would have waited: each statement's real lock time, against how often
 * queries on its table arrive.
 *
 * An estimate, and labelled as one — the rates are averages since the
 * statistics were reset, and traffic comes in bursts. But the two inputs are
 * both measured, which is more than "writes are blocked for roughly a second"
 * ever was: a two-second lock on a table read forty times a second is eighty
 * requests stuck behind it.
 */
function queueSection(rehearsal: Rehearsal, statements: readonly SplitStatement[]): string[] {
  if (!rehearsal.traffic || rehearsal.traffic.length === 0) {
    return [];
  }

  const rows: string[] = [];
  for (const result of rehearsal.statements) {
    const statement = statements.find((candidate) => candidate.index === result.index);
    if (!statement || result.status !== 'ran' || !result.milliseconds) {
      continue;
    }

    const classification = classify(statement.sql);
    const profile = lockProfileFor(classification.kind, {
      concurrently: classification.concurrently === true,
    });
    const blocksReads = profile.level === 'ACCESS EXCLUSIVE';
    const blocksWrites = blocksReads || /^SHARE/.test(profile.level) && profile.level !== 'SHARE UPDATE EXCLUSIVE';
    if (!blocksWrites) {
      continue;
    }

    const table = classification.table?.toLowerCase();
    const traffic = rehearsal.traffic.find(
      (entry) => bareName(entry.table).toLowerCase() === (table ? bareName(table) : ''),
    );
    if (!traffic) {
      continue;
    }

    const seconds = result.milliseconds / 1000;
    const rate = (blocksReads ? traffic.readsPerSecond : 0) + traffic.writesPerSecond;
    const waiting = Math.round(rate * seconds);
    if (waiting < 1) {
      continue;
    }

    rows.push(
      `| ${statement.startLine + 1} | ${profile.level} on ${traffic.table} | ` +
        `${formatMs(result.milliseconds)} | ${blocksReads ? 'reads and writes' : 'writes'} | ` +
        `about ${formatCount(waiting)} |`,
    );
  }

  if (rows.length === 0) {
    return [];
  }

  const window = rehearsal.traffic[0]!.windowSeconds;
  return [
    '## Who would have waited',
    '',
    'Each lock\'s real duration from the run above, against how often queries on the table',
    `arrive (pg_stat_statements, averaged over the last ${describeWindow(window)}). An`,
    'estimate: traffic comes in bursts, and a queue grows faster than an average says.',
    '',
    '| Line | Lock | Held for | Blocks | Requests that would queue |',
    '| ---: | --- | ---: | --- | ---: |',
    ...rows,
    '',
  ];
}

function describeWindow(seconds: number): string {
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} minutes`;
  }
  if (seconds < 172_800) {
    return `${Math.round(seconds / 3600)} hours`;
  }
  return `${Math.round(seconds / 86_400)} days`;
}

function bareName(name: string): string {
  const parts = name.split('.');
  return (parts[parts.length - 1] ?? name).replace(/"/g, '');
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
