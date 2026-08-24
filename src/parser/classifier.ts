import { maskLiterals } from './mask';

/**
 * What kind of statement is this, and what does it point at?
 *
 * Classification runs on the masked copy so that the word DELETE inside a
 * comment or a string is never mistaken for a statement. Everything the
 * analyzers need is pulled out here: the target table, the column, the
 * predicate text of a CHECK, whether a WHERE clause exists at all.
 *
 * Captures are taken by *offset*: the pattern matches the masked text, and the
 * value is then sliced out of the original at the same position. That matters
 * because a quoted identifier like `"user table"` has its contents blanked in
 * the masked copy, so reading the capture directly would return spaces.
 *
 * This is regex-driven rather than AST-driven, deliberately, and only for the
 * shapes listed below. A full parser buys accuracy on arbitrary SQL, but the
 * statements that matter here are the ones migration tools generate, which are
 * highly regular — and both candidate parsers choke on some real Postgres DDL.
 * The part that genuinely must be exact is the *splitting*, and that is handled
 * by masking rather than by pattern matching. Anything unrecognised falls
 * through to `other` and is reported as not analysable, never guessed at.
 */

export type StatementKind =
  // DML — really executed inside a rolled-back transaction
  | 'update'
  | 'delete'
  | 'insert'
  // DDL — probed, never executed
  | 'drop_column'
  | 'drop_table'
  | 'set_not_null'
  | 'drop_not_null'
  | 'alter_column_type'
  | 'add_check'
  | 'add_foreign_key'
  | 'add_unique'
  | 'create_index'
  | 'truncate'
  | 'rename_column'
  | 'rename_table'
  | 'add_column'
  | 'create_table'
  // everything else
  | 'select'
  | 'other';

export interface Classification {
  readonly kind: StatementKind;
  /** Target relation, as written (may be schema-qualified). */
  readonly table?: string;
  /** Target column, for the column-scoped kinds. */
  readonly column?: string;
  /** New type, for `alter_column_type`. */
  readonly newType?: string;
  /** The predicate inside `CHECK ( … )`. */
  readonly checkPredicate?: string;
  /** Referenced table and columns, for `add_foreign_key`. */
  readonly references?: { readonly table: string; readonly columns: string[] };
  /** Columns covered by a unique constraint, a foreign key, or an index. */
  readonly columns?: string[];
  /** True when a `CREATE INDEX` says CONCURRENTLY. */
  readonly concurrently?: boolean;
  /** False for an UPDATE or DELETE with no WHERE clause at all. */
  readonly hasWhere?: boolean;
  /** True when the statement already ends in RETURNING, which changes sampling. */
  readonly hasReturning?: boolean;
  /**
   * The alias the target table was given, if any.
   *
   * Needed to qualify a `RETURNING` list. `DELETE FROM accounts USING users`
   * puts two tables in scope, so a bare `RETURNING id` is ambiguous and the
   * statement fails — and it fails inside the preview, where the user sees an
   * unhelpful error instead of a row count.
   */
  readonly alias?: string;
}

/**
 * Words that can follow a table name without being an alias.
 *
 * `DELETE FROM accounts USING users` has no alias; reading `USING` as one
 * produces `USING.id` in the RETURNING list, which is worse than the ambiguity
 * it was meant to fix.
 */
const NOT_AN_ALIAS = new Set([
  'USING',
  'WHERE',
  'SET',
  'RETURNING',
  'FROM',
  'VALUES',
  'SELECT',
  'ON',
  'DEFAULT',
  'AS',
]);

const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_-￿][A-Za-z0-9_$-￿]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;

const re = (pattern: string, flags = 'i'): RegExp => new RegExp(pattern, `${flags}d`);

export function classify(sql: string): Classification {
  const masked = maskLiterals(sql);

  /** Slices capture group `n` out of the *original* text, by offset. */
  const cap = (match: RegExpExecArray, n: number): string | undefined => {
    const span = match.indices?.[n];
    return span ? sql.slice(span[0], span[1]) : undefined;
  };

  const alter = re(
    String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+([\s\S]*)$`,
  ).exec(masked);
  if (alter) {
    const actionSpan = alter.indices![2]!;
    return classifyAlter(sql, masked, ident(cap(alter, 1)!), actionSpan[0]);
  }

  const update = re(
    String.raw`^\s*UPDATE\s+(?:ONLY\s+)?(${QUALIFIED})(?:\s+(?:AS\s+)?(${IDENT}))?`,
  ).exec(masked);
  if (update) {
    return {
      kind: 'update',
      table: ident(cap(update, 1)!),
      ...aliasOf(cap(update, 2)),
      hasWhere: hasTopLevelKeyword(masked, 'where'),
      hasReturning: hasTopLevelKeyword(masked, 'returning'),
    };
  }

  const del = re(
    String.raw`^\s*DELETE\s+FROM\s+(?:ONLY\s+)?(${QUALIFIED})(?:\s+(?:AS\s+)?(${IDENT}))?`,
  ).exec(masked);
  if (del) {
    return {
      kind: 'delete',
      table: ident(cap(del, 1)!),
      ...aliasOf(cap(del, 2)),
      hasWhere: hasTopLevelKeyword(masked, 'where'),
      hasReturning: hasTopLevelKeyword(masked, 'returning'),
    };
  }

  const insert = re(String.raw`^\s*INSERT\s+INTO\s+(${QUALIFIED})`).exec(masked);
  if (insert) {
    return {
      kind: 'insert',
      table: ident(cap(insert, 1)!),
      hasReturning: hasTopLevelKeyword(masked, 'returning'),
    };
  }

  const truncate = re(
    String.raw`^\s*TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(${QUALIFIED})`,
  ).exec(masked);
  if (truncate) {
    return { kind: 'truncate', table: ident(cap(truncate, 1)!) };
  }

  const dropTable = re(
    String.raw`^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED})`,
  ).exec(masked);
  if (dropTable) {
    return { kind: 'drop_table', table: ident(cap(dropTable, 1)!) };
  }

  const createIndex = re(
    String.raw`^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+)?ON\s+(?:ONLY\s+)?(${QUALIFIED})\s*(?:USING\s+${IDENT}\s*)?\(([\s\S]*)\)`,
  ).exec(masked);
  if (createIndex) {
    return {
      kind: 'create_index',
      table: ident(cap(createIndex, 2)!),
      concurrently: Boolean(createIndex[1]),
      columns: splitColumns(cap(createIndex, 3) ?? ''),
    };
  }

  if (/^\s*CREATE\s+(?:GLOBAL\s+|LOCAL\s+|TEMP\w*\s+|UNLOGGED\s+)*TABLE\b/i.test(masked)) {
    const name = re(String.raw`TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`).exec(masked);
    return { kind: 'create_table', ...(name ? { table: ident(cap(name, 1)!) } : {}) };
  }

  if (/^\s*(?:SELECT|WITH|TABLE|VALUES)\b/i.test(masked)) {
    return { kind: 'select' };
  }

  return { kind: 'other' };
}

function classifyAlter(
  sql: string,
  masked: string,
  table: string,
  actionStart: number,
): Classification {
  const action = masked.slice(actionStart);
  const t = { table };

  /** Capture `n`, sliced from the original, with the action offset applied. */
  const cap = (match: RegExpExecArray, n: number): string | undefined => {
    const span = match.indices?.[n];
    return span ? sql.slice(actionStart + span[0], actionStart + span[1]) : undefined;
  };

  const dropColumn = re(
    String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENT})`,
  ).exec(action);
  if (dropColumn) {
    return { kind: 'drop_column', ...t, column: ident(cap(dropColumn, 1)!) };
  }

  const alterColumn = re(String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})\s+([\s\S]*)$`).exec(action);
  if (alterColumn) {
    const column = ident(cap(alterColumn, 1)!);
    const rest = action.slice(alterColumn.indices![2]![0]);

    if (/^SET\s+NOT\s+NULL/i.test(rest)) {
      return { kind: 'set_not_null', ...t, column };
    }
    if (/^DROP\s+NOT\s+NULL/i.test(rest)) {
      return { kind: 'drop_not_null', ...t, column };
    }

    const typeChange = re(
      String.raw`^(?:SET\s+DATA\s+)?TYPE\s+([\s\S]+?)(?:\s+USING\b|\s*$)`,
    ).exec(rest);
    if (typeChange) {
      const base = actionStart + alterColumn.indices![2]![0];
      const span = typeChange.indices![1]!;
      return {
        kind: 'alter_column_type',
        ...t,
        column,
        newType: sql.slice(base + span[0], base + span[1]).trim(),
      };
    }
  }

  if (/^ADD\s+(?:CONSTRAINT\b|CHECK\b|FOREIGN\b|UNIQUE\b|PRIMARY\b|EXCLUDE\b)/i.test(action)) {
    const prefix = re(String.raw`^ADD\s+(?:CONSTRAINT\s+${IDENT}\s+)?`).exec(action)!;
    const bodyStart = actionStart + prefix[0].length;
    const body = action.slice(prefix[0].length);

    const bodyCap = (match: RegExpExecArray, n: number): string | undefined => {
      const span = match.indices?.[n];
      return span ? sql.slice(bodyStart + span[0], bodyStart + span[1]) : undefined;
    };

    if (/^CHECK\s*\(/i.test(body)) {
      const span = balancedParens(body, body.indexOf('('));
      return {
        kind: 'add_check',
        ...t,
        ...(span ? { checkPredicate: sql.slice(bodyStart + span[0], bodyStart + span[1]).trim() } : {}),
      };
    }

    const fk = re(
      String.raw`^FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(${QUALIFIED})\s*(?:\(([^)]*)\))?`,
    ).exec(body);
    if (fk) {
      return {
        kind: 'add_foreign_key',
        ...t,
        columns: splitColumns(bodyCap(fk, 1) ?? ''),
        references: {
          table: ident(bodyCap(fk, 2)!),
          columns: splitColumns(bodyCap(fk, 3) ?? ''),
        },
      };
    }

    const unique = re(String.raw`^UNIQUE\s*\(([^)]*)\)`).exec(body);
    if (unique) {
      return { kind: 'add_unique', ...t, columns: splitColumns(bodyCap(unique, 1) ?? '') };
    }

    return { kind: 'other', ...t };
  }

  const addColumn = re(
    String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`,
  ).exec(action);
  if (addColumn) {
    return { kind: 'add_column', ...t, column: ident(cap(addColumn, 1)!) };
  }

  const renameColumn = re(
    String.raw`^RENAME\s+(?:COLUMN\s+)?(${IDENT})\s+TO\s+(${IDENT})`,
  ).exec(action);
  if (renameColumn) {
    return { kind: 'rename_column', ...t, column: ident(cap(renameColumn, 1)!) };
  }

  if (/^RENAME\s+TO\b/i.test(action)) {
    return { kind: 'rename_table', ...t };
  }

  return { kind: 'other', ...t };
}

/**
 * A keyword belonging to the statement itself, not to a subquery. Anything
 * inside parentheses is someone else's WHERE.
 */
function hasTopLevelKeyword(masked: string, keyword: string): boolean {
  const pattern = new RegExp(String.raw`^${keyword}\b`, 'i');
  let depth = 0;

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    const before = masked[i - 1];
    if ((before === undefined || /[\s)]/.test(before)) && pattern.test(masked.slice(i, i + keyword.length + 1))) {
      return true;
    }
  }
  return false;
}

/** Span of the parenthesised group beginning at `open`, excluding the parens. */
function balancedParens(text: string, open: number): [number, number] | undefined {
  if (text[open] !== '(') {
    return undefined;
  }
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) {
        return [open + 1, i];
      }
    }
  }
  return undefined;
}

function splitColumns(list: string): string[] {
  return list
    .split(',')
    .map((c) => ident(c.trim().replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))\b/gi, '').trim()))
    .filter((c) => c.length > 0);
}

/** Strips quoting and normalises whitespace around a qualified identifier. */
function ident(raw: string): string {
  return raw
    .trim()
    .split('.')
    .map((part) => {
      const p = part.trim();
      return p.startsWith('"') && p.endsWith('"') && p.length >= 2
        ? p.slice(1, -1).replace(/""/g, '"')
        : p;
    })
    .join('.');
}

/**
 * The captured word after a table name, when it really is an alias.
 *
 * `DELETE FROM accounts USING users` has none, and reading `USING` as one
 * would put `USING.id` in a RETURNING list — a worse failure than the
 * ambiguity it exists to prevent.
 */
function aliasOf(candidate: string | undefined): { alias?: string } {
  if (!candidate) {
    return {};
  }
  const name = ident(candidate);
  return NOT_AN_ALIAS.has(name.toUpperCase()) ? {} : { alias: name };
}
