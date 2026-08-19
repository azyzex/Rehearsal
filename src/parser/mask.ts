/**
 * Blanking out the parts of SQL that are not executable text.
 *
 * Everything else in the parser works on the *masked* copy: comments and
 * quoted literals become runs of spaces, while length and line structure stay
 * byte-for-byte identical to the original. That means an offset found in the
 * masked text points at exactly the same character in the real text, so the
 * splitter can find statement boundaries without ever being fooled by a
 * semicolon inside a string, and the classifier can match keywords without
 * matching the word DELETE inside a comment.
 *
 * This is the classic source of bugs in SQL tooling, so it is one small
 * function with its own tests rather than a regex sprinkled across five files.
 */

/**
 * Returns a copy of `sql` in which the contents of comments and quoted
 * literals are replaced by spaces. Newlines are preserved so line numbers
 * still line up.
 *
 * Handles line comments, block comments (nested, as Postgres allows),
 * single-quoted strings with doubled-quote escapes, double-quoted identifiers,
 * and dollar-quoted strings of any tag.
 */
export function maskLiterals(sql: string): string {
  const out = sql.split('');
  const n = sql.length;
  let i = 0;

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

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === quote && sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      // The delimiters stay visible and only the contents are blanked. A
      // string's *contents* are not executable text, but a quoted identifier
      // is part of the statement's structure — `"user table"` has to still
      // look like an identifier to the classifier, which then slices the real
      // name back out of the original text by offset.
      blank(i + 1, closed ? j - 1 : j);
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

/**
 * Returns the dollar-quote tag starting at `pos` (`$$`, `$body$`, …), or null
 * when the `$` is something else, such as a `$1` placeholder.
 */
export function matchDollarTag(sql: string, pos: number): string | null {
  const m = /^\$\$|^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$/.exec(sql.slice(pos));
  return m ? m[0] : null;
}

/** Offsets at which a top-level statement begins in already-masked text. */
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
