import { DatabaseAdapter } from '../adapters/types';
import { MigrationFile, MigrationLayout } from './discover';

/**
 * What the database says it has already run.
 *
 * Prisma and Drizzle each keep a table of applied migrations, and comparing it
 * against the folder answers two questions at once. The first is the obvious
 * one: which migrations are pending, and therefore worth previewing. The second
 * is drift — a migration the database has run that is not in this checkout,
 * which usually means someone applied something from a branch, or that this is
 * not the environment anyone thought it was.
 */

export interface LedgerStatus {
  readonly pending: readonly MigrationFile[];
  /** Applied in the database but absent from this checkout. */
  readonly unknownToRepo: readonly string[];
  readonly appliedCount: number;
  /**
   * Set when the ledger could not be read at all, in which case `pending`
   * lists everything and the caller must say so rather than implying the
   * database is empty.
   */
  readonly note?: string;
}

/** All migrations, with no ledger consulted. Used where there is none to read. */
export function everythingPending(layout: MigrationLayout, note: string): LedgerStatus {
  return {
    pending: layout.migrations,
    unknownToRepo: [],
    appliedCount: 0,
    note,
  };
}

export async function readLedger(
  adapter: DatabaseAdapter,
  layout: MigrationLayout,
): Promise<LedgerStatus> {
  switch (layout.tool) {
    case 'prisma':
      return prismaLedger(adapter, layout);
    case 'drizzle':
      return drizzleLedger(adapter, layout);
    default:
      return everythingPending(
        layout,
        'These files are plain SQL with no ledger, so Dry Run cannot tell which have ' +
          'already been applied. Every one is listed.',
      );
  }
}

async function prismaLedger(
  adapter: DatabaseAdapter,
  layout: MigrationLayout,
): Promise<LedgerStatus> {
  const rows = await safely(() =>
    adapter.withRollback(async (tx) => {
      const result = await tx.query(
        // A migration that started and failed is not applied. Prisma will
        // refuse to move past it, and previewing it is exactly what you want.
        `SELECT migration_name FROM _prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      );
      return result.rows.map((row) => String(row['migration_name']));
    }),
  );

  if (rows === undefined) {
    return everythingPending(
      layout,
      'No _prisma_migrations table in this database, so nothing here has been applied ' +
        'to it yet — or it is not the database these migrations belong to.',
    );
  }

  return compare(layout, new Set(rows), (migration) => migration.name);
}

async function drizzleLedger(
  adapter: DatabaseAdapter,
  layout: MigrationLayout,
): Promise<LedgerStatus> {
  const rows = await safely(() =>
    adapter.withRollback(async (tx) => {
      // Drizzle records when a migration was created, not what it is called,
      // so the journal's `when` is the only thing the two sides share.
      const result = await tx.query(
        `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
      );
      return result.rows.map((row) => String(row['created_at']));
    }),
  );

  if (rows === undefined) {
    return everythingPending(
      layout,
      'No drizzle.__drizzle_migrations table in this database, so nothing here has ' +
        'been applied to it yet.',
    );
  }

  const applied = new Set(rows);
  return compare(layout, applied, (migration) =>
    migration.createdAt === undefined ? undefined : String(migration.createdAt),
  );
}

function compare(
  layout: MigrationLayout,
  applied: ReadonlySet<string>,
  keyOf: (migration: MigrationFile) => string | undefined,
): LedgerStatus {
  const pending: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const migration of layout.migrations) {
    const key = keyOf(migration);
    if (key === undefined || !applied.has(key)) {
      pending.push(migration);
      continue;
    }
    seen.add(key);
  }

  return {
    pending,
    unknownToRepo: [...applied].filter((key) => !seen.has(key)),
    appliedCount: applied.size,
  };
}

/**
 * Runs a ledger read, returning undefined when the table is simply not there.
 *
 * A missing ledger is an ordinary state — a fresh database, or the wrong one —
 * and has to be told apart from a connection that is broken, which is not.
 */
async function safely<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 42P01 undefined_table, 3F000 invalid_schema_name.
    if (code === '42P01' || code === '3F000') {
      return undefined;
    }
    throw error;
  }
}
