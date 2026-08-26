import { DatabaseAdapter, Row } from "../adapters/types";
import { Edit } from "./changeset";
import { RescueWriter, rescueWriterFor } from "./rescueWriter";

/**
 * What was there before, written down before it stops being there.
 *
 * Every safeguard in this extension up to now has been about deciding *whether*
 * to apply a change. This one is about the minute afterwards. "Apply" is the
 * one irreversible act the tool performs, and the honest thing to do before an
 * irreversible act is to keep a copy of what it destroys — not a description,
 * not a count, the actual rows, in a form that puts them back.
 *
 * It is read-only and runs before the transaction that applies anything. The
 * file it produces is reviewable, diffable, and runnable by hand with no
 * tooling from here, because a rescue that depends on the tool that caused the
 * problem is not much of a rescue. Which language it is written in belongs to
 * the engine — see `rescueWriter.ts`, which also owns the filters used to find
 * the rows, because building those here in one engine's dialect is how the
 * file came to be empty on one engine and full of the wrong rows on another.
 */

export interface RescuedRows {
  readonly change: string;
  readonly table: string;
  readonly rows: readonly Row[];
  /** Total rows at risk, which may exceed what was captured. */
  readonly total: number;
  /** Statements that would put these rows back. */
  readonly restore: readonly string[];
  /** Set when the cap stopped the capture short of everything. */
  readonly truncated?: string;
}

export interface RescueFile {
  readonly sections: readonly RescuedRows[];
  /** The whole thing, ready to write to disk. */
  readonly sql: string;
  /** True when any section hit the cap: the file is not a complete copy. */
  readonly incomplete: boolean;
  readonly totalRows: number;
}

const DEFAULT_LIMIT = 5000;

/**
 * Captures the rows a changeset is about to destroy.
 *
 * Only the changes that actually lose data are captured. An `ADD COLUMN` or a
 * `CREATE INDEX` takes nothing away, and writing an empty section for it would
 * bury the sections that matter.
 */
export async function captureRescue(
  adapter: DatabaseAdapter,
  changes: readonly Edit[],
  options: { readonly limit?: number } = {},
): Promise<RescueFile> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const sections: RescuedRows[] = [];

  const writer = rescueWriterFor(adapter.engine);

  for (const change of changes) {
    const section = await capture(adapter, writer, change, limit);
    if (section && section.total > 0) {
      sections.push(section);
    }
  }

  return {
    sections,
    sql: render(sections, writer),
    incomplete: sections.some((section) => section.truncated !== undefined),
    totalRows: sections.reduce((sum, section) => sum + section.rows.length, 0),
  };
}

async function capture(
  adapter: DatabaseAdapter,
  writer: RescueWriter,
  change: Edit,
  limit: number,
): Promise<RescuedRows | undefined> {
  switch (change.kind) {
    case "drop_table": {
      const total = await adapter.countRows(change.table);
      const rows = await adapter.rowsMatching(change.table, "true", limit);
      return section(
        `DROP TABLE ${change.table}`,
        change.table,
        rows,
        total,
        limit,
        (row) => writer.insert(change.table, row),
      );
    }

    case "drop_column": {
      // Only rows that actually hold something. A column that is null
      // everywhere loses nothing, and a rescue file full of nulls hides the
      // one row that did have a value.
      const where = writer.hasValue(change.column);
      const total = await adapter.countRows(change.table, where);
      if (total === 0) {
        return undefined;
      }
      const keys = await adapter.primaryKeyColumns(change.table);
      const rows = await adapter.rowsMatching(change.table, where, limit);
      const kept = rows.map((row) => project(row, [...keys, change.column]));

      return section(
        `DROP COLUMN ${change.table}.${change.column}`,
        change.table,
        kept,
        total,
        limit,
        (row) => writer.restore(change.table, [change.column], row, keys),
      );
    }

    case "delete_row": {
      const keys = Object.keys(change.key);
      if (keys.length === 0) {
        return undefined;
      }
      const where = writer.byKey(change.key);
      const rows = await adapter.rowsMatching(change.table, where, 1);
      return section(
        `DELETE FROM ${change.table}`,
        change.table,
        rows,
        rows.length,
        limit,
        (row) => writer.insert(change.table, row),
      );
    }

    case "update_row": {
      const keys = Object.keys(change.key);
      if (keys.length === 0) {
        return undefined;
      }
      const where = writer.byKey(change.key);
      const rows = await adapter.rowsMatching(change.table, where, 1);
      const columns = Object.keys(change.set);
      const kept = rows.map((row) => project(row, [...keys, ...columns]));

      return section(
        `UPDATE ${change.table}`,
        change.table,
        kept,
        kept.length,
        limit,
        (row) => writer.restore(change.table, columns, row, keys),
      );
    }

    case "alter_type": {
      // A narrowing cast rewrites values in place, and the old ones are gone
      // whether or not the cast succeeds.
      const keys = await adapter.primaryKeyColumns(change.table);
      const where = writer.hasValue(change.column);
      const total = await adapter.countRows(change.table, where);
      if (total === 0) {
        return undefined;
      }
      const rows = await adapter.rowsMatching(change.table, where, limit);
      const kept = rows.map((row) => project(row, [...keys, change.column]));

      return section(
        `ALTER ${change.table}.${change.column} TO ${change.to}`,
        change.table,
        kept,
        total,
        limit,
        (row) => writer.restore(change.table, [change.column], row, keys),
      );
    }

    default:
      // Everything else adds, renames or constrains. None of it takes a value
      // away, so there is nothing to keep.
      return undefined;
  }
}

function section(
  label: string,
  table: string,
  rows: readonly Row[],
  total: number,
  limit: number,
  restore: (row: Row) => string,
): RescuedRows {
  return {
    change: label,
    table,
    rows,
    total,
    restore: rows.map(restore),
    truncated:
      total > rows.length
        ? `Captured ${rows.length.toLocaleString()} of ${total.toLocaleString()} rows. ` +
          `The cap is ${limit.toLocaleString()}.`
        : undefined,
  };
}

/** Narrows a row to the columns worth keeping, in the order given. */
function project(row: Row, columns: readonly string[]): Row {
  const kept: Row = {};
  for (const column of columns) {
    if (column in row) {
      kept[column] = row[column];
    }
  }
  return kept;
}


/**
 * A value as SQL text.
 *
 * This file is written to disk and read by a human, so values are inlined
 * rather than parameterised. Everything is escaped by doubling quotes, which is
 * what the SQL standard asks for and what `quote_literal` does.
 */
export function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : `'${String(value)}'`;
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (Buffer.isBuffer(value)) {
    return `'\\x${value.toString("hex")}'`;
  }
  if (typeof value === "object") {
    return quoteString(JSON.stringify(value));
  }
  return quoteString(String(value));
}

function quoteString(value: string): string {
  // E'' rather than '' when the value carries a backslash, so the escape is
  // read the way it was written whatever standard_conforming_strings says.
  const escaped = value.replace(/'/g, "''");
  return value.includes("\\")
    ? `E'${escaped.replace(/\\/g, "\\\\")}'`
    : `'${escaped}'`;
}

function render(sections: readonly RescuedRows[], writer: RescueWriter): string {
  if (sections.length === 0) {
    return "";
  }

  const mark = writer.comment;

  const lines: string[] = [
    `${mark} Dry Run rescue file`,
    `${mark} Written ${new Date().toISOString()}, before applying a changeset that destroys data.`,
    mark,
    `${mark} These ${writer.noun} put back what the changeset removed. Read them before`,
    `${mark} running them: restoring a row into a table whose shape has since changed`,
    `${mark} will not work, and putting back a row someone else has already replaced`,
    `${mark} would undo their work as well as yours.`,
    "",
  ];

  for (const section of sections) {
    lines.push(
      `${mark} ${section.change} — ${section.rows.length.toLocaleString()} rows`,
    );
    if (section.truncated) {
      lines.push(`${mark} INCOMPLETE: ${section.truncated}`);
    }
    lines.push(...section.restore, "");
  }

  return lines.join("\n");
}
