import { Finding, Severity } from '../analysis/types';

/**
 * The findings, written for something other than a panel.
 *
 * The same measurements the extension shows are worth having in a pull request,
 * and a review comment is where a destructive migration is cheapest to catch —
 * before it is merged, rather than after it has been deployed. So the analysis
 * grows a second front end that renders to text and to markdown, and an exit
 * code, and nothing else changes.
 *
 * Pure: it takes findings and returns strings, so the wording is testable
 * without a database or a terminal.
 */

export type FailLevel = Severity | 'never';

const RANK: Record<Severity, number> = {
  safe: 0,
  caution: 1,
  blocking: 2,
  destructive: 3,
};

const MARK: Record<Severity, string> = {
  safe: 'ok',
  caution: 'caution',
  blocking: 'BLOCKING',
  destructive: 'DESTRUCTIVE',
};

export interface ReportInput {
  readonly file: string;
  readonly connection: string;
  readonly findings: readonly Finding[];
}

/** Whether anything found is at or above the level that should fail a build. */
export function shouldFail(findings: readonly Finding[], level: FailLevel): boolean {
  if (level === 'never') {
    return false;
  }
  return findings.some((finding) => RANK[finding.severity] >= RANK[level]);
}

/** One line per statement, for a terminal. */
export function textReport(input: ReportInput): string {
  const lines = [`${input.file} — measured against ${input.connection}`, ''];

  if (input.findings.length === 0) {
    lines.push('No statements found.', '');
    return lines.join('\n');
  }

  for (const finding of input.findings) {
    const mark = MARK[finding.severity].padEnd(11);
    lines.push(`${mark} line ${finding.statementIndex + 1}  ${finding.headline}`);
    lines.push(`            ${finding.detail}`);

    // The two pieces of context that change a decision, and nothing else: a
    // terminal report nobody reads to the end has failed.
    if (finding.queuedBehind && finding.queuedBehind.length > 0) {
      lines.push(`            queues behind ${finding.queuedBehind.length} running session(s)`);
    }
    if (finding.triggers && finding.triggers.some((trigger) => trigger.escapes.length > 0)) {
      lines.push('            a trigger here may reach outside the transaction');
    }
    lines.push('');
  }

  lines.push(summarise(input.findings), '');
  return lines.join('\n');
}

/** A markdown report, for a pull-request comment. */
export function markdownReport(input: ReportInput): string {
  const lines = [
    '## Dry Run',
    '',
    `\`${input.file}\`, measured against **${input.connection}**. Nothing was committed.`,
    '',
  ];

  if (input.findings.length === 0) {
    lines.push('No statements found.', '');
    return lines.join('\n');
  }

  lines.push(
    '| | Line | What it does | Measured |',
    '| --- | ---: | --- | --- |',
    ...input.findings.map(
      (finding) =>
        `| ${badge(finding.severity)} | ${finding.statementIndex + 1} | ${finding.headline} | ` +
        `${escapePipes(finding.detail)} |`,
    ),
    '',
    summarise(input.findings),
    '',
  );

  const escaping = input.findings.flatMap((finding) =>
    (finding.triggers ?? []).filter((trigger) => trigger.escapes.length > 0),
  );
  if (escaping.length > 0) {
    lines.push(
      '> A trigger on one of these tables may reach outside the transaction ' +
        `(${escaping.map((trigger) => `\`${trigger.name}\``).join(', ')}). A rollback takes ` +
        'back rows; it does not take back a notification already sent.',
      '',
    );
  }

  return lines.join('\n');
}

function badge(severity: Severity): string {
  switch (severity) {
    case 'destructive':
      return '🔴';
    case 'blocking':
      return '🟠';
    case 'caution':
      return '🟡';
    default:
      return '🟢';
  }
}

function summarise(findings: readonly Finding[]): string {
  const counts = new Map<Severity, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }

  const destructive = counts.get('destructive') ?? 0;
  const blocking = counts.get('blocking') ?? 0;
  const total = findings.length;

  if (destructive === 0 && blocking === 0) {
    return `${total} ${total === 1 ? 'statement' : 'statements'}, nothing destructive found.`;
  }

  const parts: string[] = [];
  if (destructive > 0) {
    parts.push(`${destructive} would destroy data`);
  }
  if (blocking > 0) {
    parts.push(`${blocking} would fail or lock`);
  }
  return `${parts.join(', ')}. Out of ${total} ${total === 1 ? 'statement' : 'statements'}.`;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
