import { DatabaseAdapter, Row } from "../adapters/types";
import { Edit, quoteIdentifier } from "./changeset";

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
 * file it produces is plain SQL: reviewable, diffable, and runnable by hand
 * with no tooling from here, because a rescue that depends on the tool that
 * caused the problem is not much of a rescue.
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

  for (const change of changes) {
    const section = await capture(adapter, change, limit);
    if (section && section.total > 0) {
      sections.push(section);
    }
  }

  return {
    sections,
    sql: render(sections),
    incomplete: sections.some((section) => section.truncated !== undefined),
    totalRows: sections.reduce((sum, section) => sum + section.rows.length, 0),
  };
}

async function capture(
  adapter: DatabaseAdapter,
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
        (row) => insertOf(change.table, row),
      );
    }

    case "drop_column": {
      // Only rows that actually hold something. A column that is null
      // everywhere loses nothing, and a rescue file full of nulls hides the
      // one row that did have a value.
      const where = `${quoteIdentifier(change.column)} IS NOT NULL`;
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
        (row) =>
          keys.length > 0
            ? `UPDATE ${quoteIdentifier(change.table)} SET ${quoteIdentifier(change.column)} = ` +
              `${literal(row[change.column])} WHERE ${keyPredicate(row, keys)};`
            : `-- no primary key on ${change.table}; this row cannot be addressed: ` +
              `${JSON.stringify(row)}`,
      );
    }

    case "delete_row": {
      const keys = Object.keys(change.key);
      if (keys.length === 0) {
        return undefined;
      }
      const where = keyPredicate(change.key, keys);
      const rows = await adapter.rowsMatching(change.table, where, 1);
      return section(
        `DELETE FROM ${change.table}`,
        change.table,
        rows,
        rows.length,
        limit,
        (row) => insertOf(change.table, row),
      );
    }

    case "update_row": {
      const keys = Object.keys(change.key);
      if (keys.length === 0) {
        return undefined;
      }
      const where = keyPredicate(change.key, keys);
      const rows = await adapter.rowsMatching(change.table, where, 1);
      const columns = Object.keys(change.set);
      const kept = rows.map((row) => project(row, [...keys, ...columns]));

      return section(
        `UPDATE ${change.table}`,
        change.table,
        kept,
        kept.length,
        limit,
        (row) =>
          `UPDATE ${quoteIdentifier(change.table)} SET ` +
          columns
            .map(
              (column) =>
                `${quoteIdentifier(column)} = ${literal(row[column])}`,
            )
            .join(", ") +
          ` WHERE ${keyPredicate(row, keys)};`,
      );
    }

    case "alter_type": {
      // A narrowing cast rewrites values in place, and the old ones are gone
      // whether or not the cast succeeds.
      const keys = await adapter.primaryKeyColumns(change.table);
      const where = `${quoteIdentifier(change.column)} IS NOT NULL`;
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
        (row) =>
          keys.length > 0
            ? `UPDATE ${quoteIdentifier(change.table)} SET ${quoteIdentifier(change.column)} = ` +
              `${literal(row[change.column])} WHERE ${keyPredicate(row, keys)};`
            : `-- no primary key on ${change.table}: ${JSON.stringify(row)}`,
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

function insertOf(table: string, row: Row): string {
  const columns = Object.keys(row);
  return (
    `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES ` +
    `(${columns.map((column) => literal(row[column])).join(", ")});`
  );
}

function keyPredicate(row: Row, keys: readonly string[]): string {
  return keys
    .map((key) =>
      row[key] === null || row[key] === undefined
        ? `${quoteIdentifier(key)} IS NULL`
        : `${quoteIdentifier(key)} = ${literal(row[key])}`,
    )
    .join(" AND ");
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

function render(sections: readonly RescuedRows[]): string {
  if (sections.length === 0) {
    return "";
  }

  const lines: string[] = [
    "-- Dry Run rescue file",
    `-- Written ${new Date().toISOString()}, before applying a changeset that destroys data.`,
    "--",
    "-- These statements put back what the changeset removed. Read them before",
    "-- running them: restoring a row into a table whose shape has since changed",
    "-- will not work, and putting back a row someone else has already replaced",
    "-- would undo their work as well as yours.",
    "",
  ];

  for (const section of sections) {
    lines.push(
      `-- ${section.change} — ${section.rows.length.toLocaleString()} rows`,
    );
    if (section.truncated) {
      lines.push(`-- INCOMPLETE: ${section.truncated}`);
    }
    lines.push(...section.restore, "");
  }

  return lines.join("\n");
}
