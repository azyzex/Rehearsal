import { ColumnInfo, DatabaseAdapter, SchemaSnapshot, Transaction } from '../adapters/types';
import { compareSchemas } from '../analysis/compare';
import { DownMigration } from './down';

/**
 * Proving the down migration by running it.
 *
 * Every migration tool asks for a down migration. Almost nobody runs one until
 * the night it matters, and that is the night it turns out to restore the
 * column but not its default, or the table but not its index. The file looked
 * right, which is all anybody ever checked.
 *
 * Postgres can check it properly, because Postgres can take DDL back. Inside a
 * single transaction that is rolled back either way: read the schema, apply the
 * change, apply its reversal, read the schema again, and compare. If the two do
 * not match, the difference is the down migration's bug, stated as a sentence.
 *
 * This is the same trick the rest of the extension is built on, pointed at the
 * file instead of the data — and it is the only place here that runs a *pair*
 * of migrations, so the ordering guarantee matters: the down statements run in
 * the order the file has them, which is the order they would run for real.
 *
 * ---
 *
 * What it deliberately does not do:
 *
 * **It does not check data.** A down migration that restores the column and
 * leaves it empty passes here, correctly — the schema really is back. That gap
 * is what the rescue file is for, and `down.ts` already names it in `gaps`,
 * which this carries through rather than silently overwriting with a green
 * answer.
 *
 * **It only runs on Postgres.** MySQL commits DDL the moment it runs, so
 * "apply the change and take it back" is not available at any price. Saying so
 * is better than a check that only appears to have run.
 */

export interface DownVerification {
  /** False when the check could not be made, with `skipped` saying why. */
  readonly ran: boolean;
  readonly skipped?: string;
  /** True when the schema afterwards is the schema from before. */
  readonly restored: boolean;
  /** What did not come back, or did not go away. One sentence each. */
  readonly differences: readonly string[];
  /** A down statement the server refused, which is a bug in the file. */
  readonly failed?: { readonly statement: string; readonly error: string };
  /** What the down migration says it cannot undo. Carried through, not judged. */
  readonly gaps: readonly string[];
}

/**
 * The schema as this module compares it: what `compareSchemas` understands,
 * plus the indexes, which it does not.
 */
interface Shape {
  readonly snapshot: SchemaSnapshot;
  /** `schema.table.index`, sorted. */
  readonly indexes: readonly string[];
}

export interface Runnable {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

export async function verifyDownMigration(
  adapter: DatabaseAdapter,
  up: readonly Runnable[],
  down: DownMigration,
): Promise<DownVerification> {
  const gaps = down.gaps;

  if (adapter.engine !== 'postgres') {
    return {
      ran: false,
      restored: false,
      differences: [],
      gaps,
      skipped:
        'Checking a down migration means applying the change and taking it back, ' +
        'which needs a database that can undo a schema change. This one cannot, ' +
        'so the file below is generated but unproven.',
    };
  }

  if (down.statements.length === 0) {
    return {
      ran: false,
      restored: false,
      differences: [],
      gaps,
      skipped: 'There is nothing to reverse.',
    };
  }

  if (up.length === 0) {
    return { ran: false, restored: false, differences: [], gaps, skipped: 'There is nothing to apply.' };
  }

  return adapter.withRollback(async (tx) => {
    const before = await snapshotWithin(tx);

    // A change that will not apply is not a fact about its reversal, and
    // reporting it as one would send someone to fix the wrong file.
    for (const statement of up) {
      try {
        await tx.query(statement.sql, statement.params);
      } catch (error) {
        return {
          ran: false,
          restored: false,
          differences: [],
          gaps,
          skipped:
            `The change itself did not apply, so its reversal could not be checked: ` +
            `${messageOf(error)}`,
        };
      }
    }

    for (const statement of down.statements) {
      try {
        await tx.query(statement);
      } catch (error) {
        // A down migration that will not run is the worst kind: it is the one
        // that gets discovered at two in the morning.
        return {
          ran: true,
          restored: false,
          differences: [],
          gaps,
          failed: { statement, error: messageOf(error) },
        };
      }
    }

    const after = await snapshotWithin(tx);
    const differences = describe(before, after);

    return { ran: true, restored: differences.length === 0, differences, gaps };
  });
}

/**
 * What the reversal did not put back, in the reader's terms.
 *
 * Everything is phrased as a fact about the down migration rather than as a
 * diff between two schemas: "users.email came back nullable" is actionable,
 * and "nullable: false vs true" is a puzzle.
 */
function describe(before: Shape, after: Shape): string[] {
  const comparison = compareSchemas(before.snapshot, after.snapshot);
  const differences: string[] = [];

  for (const table of comparison.tablesOnlyInLeft) {
    differences.push(`${table} is gone. The reversal does not bring it back.`);
  }
  for (const table of comparison.tablesOnlyInRight) {
    differences.push(`${table} is still there. The reversal does not remove it.`);
  }

  for (const table of comparison.tables) {
    for (const column of table.onlyInLeft) {
      differences.push(`${table.table}.${column} is missing. The reversal does not restore it.`);
    }
    for (const column of table.onlyInRight) {
      differences.push(`${table.table}.${column} is still there. The reversal does not drop it.`);
    }
    for (const change of table.changed) {
      const name = `${table.table}.${change.column}`;
      switch (change.what) {
        case 'type':
          differences.push(`${name} came back as ${change.right}, not ${change.left}.`);
          break;
        case 'nullability':
          differences.push(
            change.right === 'nullable'
              ? `${name} came back nullable. It was not before.`
              : `${name} came back NOT NULL. It was nullable before.`,
          );
          break;
        default:
          differences.push(
            change.left === 'none'
              ? `${name} came back with a default of ${change.right}, and had none before.`
              : `${name} came back without its default of ${change.left}.`,
          );
          break;
      }
    }
  }

  for (const key of comparison.foreignKeysOnlyInLeft) {
    differences.push(`The foreign key ${key} is gone. The reversal does not restore it.`);
  }
  for (const key of comparison.foreignKeysOnlyInRight) {
    differences.push(`The foreign key ${key} is still there. The reversal does not drop it.`);
  }

  // Indexes are compared here rather than through `compareSchemas`, which does
  // not look at them. Forgetting to drop the index a migration created is one
  // of the two most common bugs in a down migration; the other is the default.
  const had = new Set(before.indexes);
  const has = new Set(after.indexes);
  for (const index of before.indexes.filter((name) => !has.has(name))) {
    differences.push(`The index ${index} is gone. The reversal does not restore it.`);
  }
  for (const index of after.indexes.filter((name) => !had.has(name))) {
    differences.push(`The index ${index} is still there. The reversal does not drop it.`);
  }

  return differences;
}

/**
 * The schema, read from inside the transaction.
 *
 * `schemaSnapshot()` on the adapter uses its own connection, which cannot see
 * uncommitted DDL — so it would read the schema as it was before the change
 * both times and report every down migration as perfect. This has to be the
 * same transaction the statements ran in.
 *
 * Deliberately narrower than the adapter's version: sizes and row counts are
 * left at zero, because the comparison does not look at them and reading them
 * inside a transaction that has just rewritten the table would be measuring
 * noise.
 */
async function snapshotWithin(tx: Transaction): Promise<Shape> {
  const tables = await tx.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind = 'p' AS partitioned
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
      ORDER BY n.nspname, c.relname`,
  );

  const columns = await tx.query(
    `SELECT n.nspname AS schema,
            c.relname AS "table",
            a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(ad.adbin, ad.adrelid) AS default_expression,
            COALESCE(pk.is_primary, false) AS is_primary
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       LEFT JOIN LATERAL (
         SELECT true AS is_primary
           FROM pg_index i
          WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)
          LIMIT 1
       ) pk ON true
      WHERE c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
      ORDER BY n.nspname, c.relname, a.attnum`,
  );

  const keys = await tx.query(
    `SELECT c.conname AS name,
            srcn.nspname AS from_schema, src.relname AS from_table,
            tgtn.nspname AS to_schema, tgt.relname AS to_table,
            (SELECT array_agg(att.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute att
                 ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS from_columns,
            (SELECT array_agg(att.attname::text ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute att
                 ON att.attrelid = c.confrelid AND att.attnum = k.attnum) AS to_columns
       FROM pg_constraint c
       JOIN pg_class src ON src.oid = c.conrelid
       JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
       JOIN pg_class tgt ON tgt.oid = c.confrelid
       JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
      WHERE c.contype = 'f'
        AND srcn.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );

  const indexes = await tx.query(
    `SELECT schemaname AS schema, tablename AS "table", indexname AS name
       FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  );

  const byTable = new Map<string, ColumnInfo[]>();
  for (const row of columns.rows) {
    const key = `${String(row['schema'])}.${String(row['table'])}`;
    const list = byTable.get(key) ?? [];
    list.push({
      name: String(row['name']),
      type: String(row['type']),
      nullable: Boolean(row['nullable']),
      isPrimaryKey: Boolean(row['is_primary']),
      defaultExpression:
        row['default_expression'] === null || row['default_expression'] === undefined
          ? undefined
          : String(row['default_expression']),
    });
    byTable.set(key, list);
  }

  const schemas = [...new Set(tables.rows.map((row) => String(row['schema'])))].sort();

  const snapshot: SchemaSnapshot = {
    schemas,
    tables: tables.rows.map((row) => {
      const schema = String(row['schema']);
      const name = String(row['name']);
      const qualified = schema === 'public' ? name : `${schema}.${name}`;
      return {
        schema,
        name,
        qualified,
        rows: 0,
        bytes: 0,
        partitioned: Boolean(row['partitioned']),
        columns: byTable.get(`${schema}.${name}`) ?? [],
      };
    }),
    foreignKeys: keys.rows.map((row) => ({
      name: String(row['name']),
      fromTable: qualify(row['from_schema'], row['from_table']),
      fromColumns: (row['from_columns'] as string[] | null) ?? [],
      toTable: qualify(row['to_schema'], row['to_table']),
      toColumns: (row['to_columns'] as string[] | null) ?? [],
    })),
  };

  return {
    snapshot,
    indexes: indexes.rows
      .map((row) => `${qualify(row['schema'], row['table'])}.${String(row['name'])}`)
      .sort(),
  };
}

function qualify(schema: unknown, table: unknown): string {
  return String(schema) === 'public' ? String(table) : `${String(schema)}.${String(table)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The verification as comment lines for the top of the file.
 *
 * It goes into the file rather than into a notification because the file is
 * what gets committed, reviewed, and read again at two in the morning.
 */
export function describeVerification(verification: DownVerification): string[] {
  const lines: string[] = [];

  if (!verification.ran) {
    lines.push(`Not checked: ${verification.skipped}`);
  } else if (verification.failed) {
    lines.push(
      'CHECKED, AND IT DOES NOT RUN. Applied against this database and then',
      'reversed, the server refused this statement:',
      '',
      `  ${verification.failed.statement}`,
      `  ${verification.failed.error}`,
    );
  } else if (verification.restored) {
    lines.push(
      'Checked: applied against this database and then reversed, the schema',
      'came back exactly as it was.',
    );
  } else {
    lines.push(
      'CHECKED, AND IT DOES NOT FULLY REVERSE THE CHANGE. Applied against this',
      'database and then reversed, the schema differed:',
      '',
    );
    for (const difference of verification.differences) {
      lines.push(`  - ${difference}`);
    }
  }

  // The gaps are not repeated here: `down.ts` already writes them into the
  // file under "What this does NOT undo", and this sits directly above it.
  return lines;
}
