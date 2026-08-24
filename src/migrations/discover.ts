import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Which migrations this database has not seen yet.
 *
 * Prisma and Drizzle both hand you their generated SQL and then a warning with
 * no number in it — "possible data loss", "you are about to drop a column".
 * Possible how? Losing what? The answer is sitting in the database and neither
 * tool goes and looks, because neither wants to connect to production to
 * generate a migration.
 *
 * This module does the boring half: work out which files are migrations, which
 * of them the target database has already run, and hand the rest to the same
 * preview pipeline everything else goes through. The interesting half is that
 * the preview then runs each one against real data and replaces "possible data
 * loss" with a row count.
 *
 * Discovery is filesystem-only and takes a plain directory path, so it is
 * testable without an editor.
 */

export type MigrationTool = 'prisma' | 'drizzle' | 'plain';

export interface MigrationFile {
  /** The name the tool records in its ledger, which is how they are matched. */
  readonly name: string;
  readonly file: string;
  readonly tool: MigrationTool;
  /**
   * Drizzle records when a migration was created rather than what it is
   * called, so its ledger is matched on this instead of on the name.
   */
  readonly createdAt?: number;
}

export interface MigrationLayout {
  readonly tool: MigrationTool;
  readonly root: string;
  readonly migrations: readonly MigrationFile[];
}

/**
 * Finds the migrations in a project.
 *
 * Prisma and Drizzle are looked for first because their layouts are specific
 * enough to be recognised with confidence. A bare `migrations/` folder of .sql
 * files is the fallback: common, unambiguous to read, and impossible to match
 * against a ledger because there is not one.
 */
export function findMigrations(root: string): MigrationLayout | undefined {
  return prismaLayout(root) ?? drizzleLayout(root) ?? plainLayout(root);
}

function prismaLayout(root: string): MigrationLayout | undefined {
  const directory = path.join(root, 'prisma', 'migrations');
  if (!isDirectory(directory)) {
    return undefined;
  }

  const migrations: MigrationFile[] = [];
  for (const entry of readdir(directory).sort()) {
    const file = path.join(directory, entry, 'migration.sql');
    if (isDirectory(path.join(directory, entry)) && isFile(file)) {
      // The directory name is exactly what lands in `_prisma_migrations`.
      migrations.push({ name: entry, file, tool: 'prisma' });
    }
  }

  return migrations.length > 0 ? { tool: 'prisma', root: directory, migrations } : undefined;
}

function drizzleLayout(root: string): MigrationLayout | undefined {
  for (const folder of ['drizzle', 'migrations']) {
    const directory = path.join(root, folder);
    const journalPath = path.join(directory, 'meta', '_journal.json');
    if (!isFile(journalPath)) {
      continue;
    }

    const journal = readJson(journalPath);
    const entries = Array.isArray(journal?.['entries']) ? journal['entries'] : [];

    const migrations: MigrationFile[] = [];
    for (const entry of entries as Record<string, unknown>[]) {
      const tag = typeof entry['tag'] === 'string' ? entry['tag'] : undefined;
      if (!tag) {
        continue;
      }
      const file = path.join(directory, `${tag}.sql`);
      if (isFile(file)) {
        migrations.push({
          name: tag,
          file,
          tool: 'drizzle',
          // Drizzle's ledger stores the creation timestamp, not the tag, so
          // this is what the two get matched on.
          createdAt: typeof entry['when'] === 'number' ? entry['when'] : undefined,
        });
      }
    }

    if (migrations.length > 0) {
      return { tool: 'drizzle', root: directory, migrations };
    }
  }
  return undefined;
}

function plainLayout(root: string): MigrationLayout | undefined {
  for (const folder of ['migrations', 'db/migrations', 'sql/migrations']) {
    const directory = path.join(root, ...folder.split('/'));
    if (!isDirectory(directory)) {
      continue;
    }

    const migrations = readdir(directory)
      .filter((entry) => entry.toLowerCase().endsWith('.sql'))
      .sort()
      .map((entry) => ({
        name: entry,
        file: path.join(directory, entry),
        tool: 'plain' as const,
      }));

    if (migrations.length > 0) {
      return { tool: 'plain', root: directory, migrations };
    }
  }
  return undefined;
}

/** Reads a migration's SQL, with the tool's own comment lines left in place. */
export function readMigration(migration: MigrationFile): string {
  return fs.readFileSync(migration.file, 'utf8');
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function readdir(target: string): string[] {
  try {
    return fs.readdirSync(target);
  } catch {
    return [];
  }
}

function readJson(target: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
