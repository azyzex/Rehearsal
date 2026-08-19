import { maskLiterals, statementStarts } from './mask';

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
