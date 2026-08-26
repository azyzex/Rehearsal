import { DatabaseAdapter, Row } from '../adapters/types';
import { Classification } from '../parser/classifier';

/**
 * The rows that are actually in the way.
 *
 * "12 rows have no email" is where every other tool stops, and it is the point
 * at which the work starts. The next questions are always which twelve, and
 * what should they be — and both are answerable against the same data the
 * count came from.
 *
 * The generated fix is a starting point with a hole in it, deliberately. Only
 * the person who knows the domain can say what a missing email should become,
 * and a tool that silently picked something would be inventing data. So the
 * statement is real, runnable, and contains a placeholder that has to be
 * filled in — and it goes through the ordinary preview like anything else.
 */

export type OffenderKind = 'null' | 'orphan' | 'duplicate' | 'violation' | 'uncastable';

export interface Offenders {
  readonly kind: OffenderKind;
  readonly table: string;
  /** The column at issue, where there is a single one. */
  readonly column?: string;
  readonly total: number;
  readonly rows: readonly Row[];
  /** A statement that would resolve them, or undefined when none is safe to guess. */
  readonly fix?: OffenderFix;
}

export interface OffenderFix {
  readonly title: string;
  readonly sql: string;
  /** True when the SQL contains a placeholder the user has to replace. */
  readonly needsEditing: boolean;
  readonly note: string;
}

/**
 * Finds the rows behind a blocking count.
 *
 * Read-only, and separate from the analysis proper: it runs when the user asks
 * to see them, because fetching rows for every finding in a migration would
 * make previewing a file slower for information most rows never need.
 */
export async function findOffenders(
  adapter: DatabaseAdapter,
  classification: Classification,
  limit: number,
): Promise<Offenders | undefined> {
  const table = classification.table;
  if (!table) {
    return undefined;
  }

  // Every predicate below is SQL, and the two interesting ones are a NOT EXISTS
  // and a GROUP BY — neither of which is a filter MongoDB can be handed. The
  // nullable case *is* expressible there and is answered; the other two are
  // not, and returning nothing is the honest answer rather than a query that
  // throws into a log nobody opens.
  const quote = quoterFor(adapter);
  if (!quote) {
    return classification.kind === 'set_not_null'
      ? mongoNulls(adapter, table, classification.column, limit)
      : undefined;
  }

  switch (classification.kind) {
    case 'set_not_null': {
      const column = classification.column;
      if (!column) {
        return undefined;
      }
      const where = `${quote(column)} IS NULL`;
      return {
        kind: 'null',
        table,
        column,
        total: await adapter.countRows(table, where),
        rows: await adapter.rowsMatching(table, where, limit),
        fix: {
          title: 'Backfill them',
          sql: `UPDATE ${table} SET ${column} = /* the right value */ WHERE ${column} IS NULL`,
          needsEditing: true,
          note:
            'Only you can say what these should be. Replace the placeholder, then ' +
            'preview it — the result is measured like any other statement.',
        },
      };
    }

    case 'add_foreign_key': {
      const reference = classification.references;
      const columns = classification.columns ?? [];
      if (!reference || columns.length === 0) {
        return undefined;
      }

      const column = columns[0]!;
      const target = reference.columns[0] ?? 'id';
      const where =
        `${quote(column)} IS NOT NULL AND NOT EXISTS ` +
        `(SELECT 1 FROM ${reference.table} WHERE ${reference.table}.${quote(target)} = ${table}.${quote(column)})`;

      return {
        kind: 'orphan',
        table,
        column,
        total: await adapter.countRows(table, where),
        rows: await adapter.rowsMatching(table, where, limit),
        fix: {
          title: 'Detach them',
          sql: `UPDATE ${table} SET ${column} = NULL WHERE ${where}`,
          needsEditing: false,
          note:
            `Sets the dangling reference to null, which lets the key be added. ` +
            `Deleting the rows instead is the other option, and a much larger one — ` +
            `preview either before choosing.`,
        },
      };
    }

    case 'add_unique': {
      const columns = classification.columns ?? [];
      if (columns.length === 0) {
        return undefined;
      }

      const list = columns.map(quote).join(', ');
      const notNull = columns.map((c) => `${quote(c)} IS NOT NULL`).join(' AND ');
      const where =
        `${notNull} AND (${list}) IN ` +
        `(SELECT ${list} FROM ${table} WHERE ${notNull} GROUP BY ${list} HAVING COUNT(*) > 1)`;

      return {
        kind: 'duplicate',
        table,
        column: columns.join(', '),
        total: await adapter.countRows(table, where),
        // Ordered so the members of a group sit together — otherwise the rows
        // look unrelated and the duplication is invisible in the sample.
        rows: await adapter.rowsMatching(table, where, limit, list),
        fix: {
          title: 'Keep the first of each, delete the rest',
          sql:
            `DELETE FROM ${table} a USING ${table} b\n` +
            ` WHERE a.ctid > b.ctid\n` +
            `   AND (${columns.map((c) => `a.${quote(c)} = b.${quote(c)}`).join(' AND ')})`,
          needsEditing: false,
          note:
            'Keeps the physically first row of each group and deletes the others. ' +
            'Which one is "first" is arbitrary — if it matters, choose by a column ' +
            'you care about instead, and preview it either way.',
        },
      };
    }

    case 'add_check': {
      const predicate = classification.checkPredicate;
      if (!predicate) {
        return undefined;
      }
      const where = `NOT (${predicate})`;
      return {
        kind: 'violation',
        table,
        total: await adapter.countRows(table, where),
        rows: await adapter.rowsMatching(table, where, limit),
        fix: {
          title: 'Delete them',
          sql: `DELETE FROM ${table} WHERE ${where}`,
          needsEditing: false,
          note:
            'Deleting is the blunt option and usually the wrong one — these rows ' +
            'exist for a reason. More often the fix is an UPDATE that brings them ' +
            'inside the constraint, or a constraint that admits them.',
        },
      };
    }

    case 'drop_column': {
      // Not a blocker, but the same question: which rows am I about to empty?
      const column = classification.column;
      if (!column) {
        return undefined;
      }
      const where = `${quote(column)} IS NOT NULL`;
      return {
        kind: 'violation',
        table,
        column,
        total: await adapter.countRows(table, where),
        rows: await adapter.rowsMatching(table, where, limit),
      };
    }

    default:
      return undefined;
  }
}

/**
 * How this engine quotes an identifier, or nothing if it has no SQL to quote.
 *
 * This used to be a module-level function that always answered the ANSI way,
 * which MySQL reads as a string literal: `"phone" IS NULL` asks whether the
 * constant 'phone' is null, which it never is. The scan found no offending rows
 * on a table full of them, and reported that as a clean result.
 */
function quoterFor(adapter: DatabaseAdapter): ((name: string) => string) | undefined {
  return adapter.quoteIdentifier ? (name) => adapter.quoteIdentifier!(name) : undefined;
}

/**
 * The documents with no value in a field, for MongoDB.
 *
 * `{ field: null }` matches both a null and a missing field, which is the same
 * question `IS NULL` asks and the same set that would fail a required field.
 */
async function mongoNulls(
  adapter: DatabaseAdapter,
  table: string,
  column: string | undefined,
  limit: number,
): Promise<Offenders | undefined> {
  if (!column) {
    return undefined;
  }

  const where = JSON.stringify({ [column]: null });
  return {
    kind: 'null',
    table,
    column,
    total: await adapter.countRows(table, where),
    rows: await adapter.rowsMatching(table, where, limit),
    fix: {
      title: 'Backfill them',
      sql:
        `db.getCollection(${JSON.stringify(table)}).updateMany(` +
        `{ ${JSON.stringify(column)}: null }, ` +
        `{ $set: { ${JSON.stringify(column)}: /* the right value */ } })`,
      needsEditing: true,
      note:
        'Only you can say what these should be. Replace the placeholder, then ' +
        'preview it — the result is measured like any other operation.',
    },
  };
}
