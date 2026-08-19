/**
 * Detection of transaction-control statements.
 *
 * The statements Dry Run executes come out of the user's own migration files.
 * A file that contains a literal `COMMIT;` would, without this check, commit
 * the preview transaction and persist every change the preview just made —
 * the exact harm the extension exists to prevent. So every statement is
 * screened before it reaches the server.
 *
 * The screen has to survive SQL's quoting rules, because `'-- COMMIT'` is a
 * string and `COMMIT` inside a `$$ ... $$` function body is not a statement.
 * `maskLiterals` blanks out everything that is not executable text, keeping
 * character offsets intact so the remaining scan is a plain string walk.
 */

const TX_CONTROL_KEYWORDS: readonly string[] = [
  'COMMIT',
  'END', // alias for COMMIT
  'ROLLBACK',
  'BEGIN',
  'START', // START TRANSACTION
  'SAVEPOINT',
  'RELEASE',
  'PREPARE', // only PREPARE TRANSACTION; plain PREPARE is allowed, see below
  'ABORT',
];

/**
 * Replaces the contents of comments and quoted literals with spaces, leaving
 * length and all other characters untouched. Handles line comments, block
 * comments (nested, as Postgres allows), single-quoted strings with doubled-quote
 * escapes, double-quoted identifiers, and dollar-quoted strings of any tag.
 */
export function maskLiterals(sql: string): string {
  const out = sql.split('');
  let i = 0;
  const n = sql.length;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') {
        out[k] = ' ';
      }
    }
  };

  while (i < n) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === '*/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    const ch = sql[i];

    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (ch === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? n : close + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    i++;
  }

  return out.join('');
}

/** Returns the dollar-quote tag starting at `pos` (e.g. `$$` or `$body$`), or null. */
function matchDollarTag(sql: string, pos: number): string | null {
  const m = /^\$[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*\$|^\$\$/.exec(sql.slice(pos));
  return m ? m[0] : null;
}

/** Offsets at which a top-level statement begins. */
export function statementStarts(masked: string): number[] {
  const starts: number[] = [];
  let expectStart = true;
  let depth = 0;

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    }

    if (ch === ';' && depth === 0) {
      expectStart = true;
      continue;
    }
    if (expectStart && ch !== undefined && !/\s/.test(ch)) {
      starts.push(i);
      expectStart = false;
    }
  }

  return starts;
}

/**
 * Returns the first transaction-control statement found in `sql`, or null.
 * The returned string is the offending keyword as written.
 */
export function findTransactionControl(sql: string): string | null {
  const masked = maskLiterals(sql);

  for (const start of statementStarts(masked)) {
    const words = masked
      .slice(start, start + 64)
      .split(/[^A-Za-z_]+/)
      .filter((w) => w.length > 0);

    const first = (words[0] ?? '').toUpperCase();
    const second = (words[1] ?? '').toUpperCase();

    if (!TX_CONTROL_KEYWORDS.includes(first)) {
      continue;
    }

    // `PREPARE stmt AS ...` is an ordinary prepared statement and is fine.
    // `PREPARE TRANSACTION 'x'` commits a two-phase transaction and is not.
    if (first === 'PREPARE' && second !== 'TRANSACTION') {
      continue;
    }
    // `START` is only transaction control in `START TRANSACTION`.
    if (first === 'START' && second !== 'TRANSACTION') {
      continue;
    }
    // `RELEASE` is only transaction control in `RELEASE [SAVEPOINT] name`.
    if (first === 'RELEASE' && second.length === 0) {
      continue;
    }

    return second.length > 0 && (first === 'PREPARE' || first === 'START')
      ? `${first} ${second}`
      : first;
  }

  return null;
}
