import { Rewrite } from '../analysis/rewrite';

/**
 * The replacement text: why, then what.
 *
 * The rationale is wrapped as SQL comments at the statement's own indentation,
 * because a migration is read in a diff long after the panel that explained it
 * has been closed.
 */
export function replacement(rewrite: Rewrite, indent: string): string {
  const lines: string[] = [];

  for (const line of wrap(rewrite.rationale, 74)) {
    lines.push(`${indent}-- ${line}`);
  }

  if (rewrite.needsSeparateTransactions) {
    lines.push(
      `${indent}-- These must not share a transaction. Most migration tools wrap a`,
      `${indent}-- file in one, so this belongs in separate files or needs the`,
      `${indent}-- tool's no-transaction escape hatch.`,
    );
  }

  // The file's own semicolon is left where it is: the replaced range stops
  // just before it, so joining with one here keeps exactly one per statement.
  for (const [index, statement] of rewrite.statements.entries()) {
    lines.push(`${indent}${statement}${index === rewrite.statements.length - 1 ? '' : ';'}`);
    if (index < rewrite.statements.length - 1) {
      lines.push('');
    }
  }

  // The range starts at the statement, which is already past the indentation,
  // so the first line must not repeat it.
  const text = lines.join('\n');
  return text.startsWith(indent) ? text.slice(indent.length) : text;
}

/** Greedy wrap. Comments in a migration are read at whatever width the diff is. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line.length > 0) {
    lines.push(line);
  }

  return lines;
}
