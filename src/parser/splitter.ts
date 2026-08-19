import { maskLiterals } from './mask';

/**
 * Splitting a file into statements.
 *
 * Every row in the panel is one of these, so the split has to be right: a
 * miscounted statement means a severity badge pointing at the wrong line, and
 * a badge on the wrong line is worse than no badge.
 *
 * All boundary detection runs on the masked copy (see `mask.ts`), which is why
 * a semicolon inside `'acme; holdings'` or inside a `$$ … $$` function body is
 * not a boundary. The text that comes back out is sliced from the original.
 */

export interface SplitStatement {
  /** 0-based position in the file. */
  readonly index: number;
  /** The statement text, without its trailing semicolon or surrounding blanks. */
  readonly sql: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** 0-based, for VS Code ranges. */
  readonly startLine: number;
  readonly endLine: number;
}

export function splitStatements(text: string): SplitStatement[] {
  const masked = maskLiterals(text);
  const lineStarts = indexLines(text);
  const statements: SplitStatement[] = [];

  let depth = 0;
  let segmentStart = 0;

  const push = (from: number, to: number): void => {
    // Trim using the masked copy, so leading comments and trailing whitespace
    // fall away but a statement that *begins* with a string does not.
    let start = from;
    let end = to;
    while (start < end && isBlank(masked[start])) {
      start++;
    }
    while (end > start && isBlank(masked[end - 1])) {
      end--;
    }
    if (start >= end) {
      return; // nothing but comments and whitespace
    }

    statements.push({
      index: statements.length,
      sql: text.slice(start, end),
      startOffset: start,
      endOffset: end,
      startLine: lineOf(lineStarts, start),
      endLine: lineOf(lineStarts, end - 1),
    });
  };

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      push(segmentStart, i);
      segmentStart = i + 1;
    }
  }

  push(segmentStart, masked.length);

  return statements;
}

/** The statement containing `offset`, or the one nearest above it. */
export function statementAt(
  statements: readonly SplitStatement[],
  offset: number,
): SplitStatement | undefined {
  let candidate: SplitStatement | undefined;
  for (const statement of statements) {
    if (offset >= statement.startOffset && offset <= statement.endOffset) {
      return statement;
    }
    if (statement.startOffset <= offset) {
      candidate = statement;
    }
  }
  return candidate;
}

function isBlank(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function indexLines(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
