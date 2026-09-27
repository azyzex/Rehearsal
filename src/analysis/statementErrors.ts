/**
 * What a failed statement means, and what to do about it.
 *
 * A preview really executes the statement, so it fails the way the migration
 * would — and the server's message is written for someone who already knows
 * why. "relation "audit_log" does not exist", under a statement about `users`,
 * reads like a bug in the tool. It is almost always a trigger on `users`
 * writing to a table this database does not have: a real finding, and the
 * migration would fail on it in the same way.
 *
 * So the raw message is kept and a sentence is put in front of it. Only for
 * failures whose meaning is certain from the message alone; anything else is
 * left as the server said it, because a confident wrong explanation is worse
 * than none.
 */

export interface ErrorContext {
  readonly sql: string;
  /** The table the statement targets, when the classifier found one. */
  readonly table?: string;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}

export function explainStatementError(message: string, context: ErrorContext): string {
  const explained = explain(message, context);
  return explained ? `${explained} The server said: ${message}` : message;
}

function explain(message: string, context: ErrorContext): string | undefined {
  const on = context.table ? ` on ${context.table}` : '';

  // Postgres: relation "x" does not exist.  MySQL: Table 'db.x' doesn't exist.
  const missing =
    /relation "([^"]+)" does not exist/i.exec(message) ??
    /Table '(?:[^'.]+\.)?([^']+)' doesn't exist/i.exec(message);
  if (missing) {
    const name = missing[1]!;
    return mentions(context.sql, name)
      ? `${name} does not exist in this database. If an earlier statement in this file ` +
          `creates it, preview the whole file rather than a selection.`
      : `The statement never names ${name}, so something it sets off does — usually a ` +
          `trigger${on}, or a view or rule built on it. That is a real finding: the ` +
          `migration would fail on it the same way.`;
  }

  // Postgres: column "x" does not exist.  MySQL: Unknown column 'x'.
  const column =
    /column "([^"]+)"(?: of relation "[^"]+")? does not exist/i.exec(message) ??
    /Unknown column '([^']+)'/i.exec(message);
  if (column) {
    const name = column[1]!.split('.').pop()!;
    return mentions(context.sql, name)
      ? `${name} is not a column here. If an earlier statement in this file adds it, ` +
          `preview the whole file rather than a selection.`
      : `The statement never names ${name}, so a trigger${on} or a default expression ` +
          `refers to it. The migration would fail on it the same way.`;
  }

  if (/permission denied|access denied|command denied|not authorized/i.test(message)) {
    return (
      `The role Rehearsal connects as is not allowed to do this. That is worth knowing on ` +
      `its own: if your migrations run as the same role, they fail here too. Otherwise, ` +
      `connect as the role your migrations use.`
    );
  }

  if (/statement timeout|maximum statement execution time/i.test(message)) {
    const limit = context.statementTimeoutMs ? ` of ${formatMs(context.statementTimeoutMs)}` : '';
    return (
      `It ran past the time limit${limit} and was stopped, so nothing past that point was ` +
      `measured. On a table this size that is a finding in itself. Raise ` +
      `rehearsal.statementTimeoutMs to measure it fully.`
    );
  }

  if (/lock timeout|lock wait timeout|could not obtain lock/i.test(message)) {
    const limit = context.lockTimeoutMs ? ` within ${formatMs(context.lockTimeoutMs)}` : '';
    return (
      `It could not get its lock${limit}: another session is holding ${context.table ?? 'the table'}. ` +
      `In production this is the moment a migration starts making every query behind it wait.`
    );
  }

  return undefined;
}

/** Whether `name` appears in the statement as a word, not inside another one. */
function mentions(sql: string, name: string): boolean {
  const bare = name.split('.').pop()!.replace(/"/g, '');
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(sql);
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
}
