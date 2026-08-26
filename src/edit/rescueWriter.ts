import { Engine, Row } from '../adapters/types';
import { quoteIdentifier } from './changeset';
import { literal } from './rescue';

/**
 * How each engine asks for rows, and how it puts them back.
 *
 * The rescue file is the safety net: the copy taken before the one irreversible
 * thing this extension does. It was written entirely in SQL, and both halves of
 * that were wrong on two of the three engines.
 *
 * The half nobody would have noticed is the *filter*. Finding the rows a
 * `DROP COLUMN` is about to empty means asking for "the ones with a value in
 * it", and that was built as `"column" IS NOT NULL` — ANSI quoting, the same
 * leak that once reported a failing MySQL migration as safe. MySQL reads
 * `"column"` as the string 'column', which is never null, so it matched every
 * row and the rescue file filled up with the nulls it exists to keep out of the
 * way. MongoDB parses its filters as JSON and threw outright, so a rescue on a
 * `$unset` produced no file at all — the safety net missing precisely when it
 * was being relied on.
 *
 * The half anyone would have noticed is the statements: `INSERT INTO` handed to
 * someone whose database has no tables.
 *
 * Both live here now, per engine, so neither can drift from the other.
 */
export interface RescueWriter {
  readonly engine: Engine;

  /** The comment marker the file uses. */
  readonly comment: string;

  /** What to call the thing that puts rows back, in a sentence. */
  readonly noun: string;

  /** A filter meaning "this field holds a value", in this engine's language. */
  hasValue(column: string): string;

  /** A filter matching the row this key identifies. */
  byKey(key: Row): string;

  /** Puts one whole captured row back. */
  insert(table: string, row: Row): string;

  /** Puts the listed fields back onto the row the keys identify. */
  restore(
    table: string,
    columns: readonly string[],
    row: Row,
    keys: readonly string[],
  ): string;
}

const SQL_WRITER: RescueWriter = {
  engine: 'postgres',
  comment: '--',
  noun: 'statements',

  hasValue: (column) => `${quoteIdentifier(column)} IS NOT NULL`,

  byKey: (key) =>
    Object.keys(key)
      .map((name) =>
        key[name] === null || key[name] === undefined
          ? `${quoteIdentifier(name)} IS NULL`
          : `${quoteIdentifier(name)} = ${literal(key[name])}`,
      )
      .join(' AND '),

  insert: (table, row) => {
    const columns = Object.keys(row);
    return (
      `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ` +
      `(${columns.map((column) => literal(row[column])).join(', ')});`
    );
  },

  restore: (table, columns, row, keys) => {
    if (keys.length === 0) {
      return `-- no primary key on ${table}; this row cannot be addressed: ${JSON.stringify(row)}`;
    }
    const assignments = columns
      .map((column) => `${quoteIdentifier(column)} = ${literal(row[column])}`)
      .join(', ');
    const where = keys
      .map((key) =>
        row[key] === null || row[key] === undefined
          ? `${quoteIdentifier(key)} IS NULL`
          : `${quoteIdentifier(key)} = ${literal(row[key])}`,
      )
      .join(' AND ');

    return `UPDATE ${quoteIdentifier(table)} SET ${assignments} WHERE ${where};`;
  },
};

/**
 * MySQL is SQL with different quotes.
 *
 * Backticks rather than double quotes, because MySQL's default sql_mode reads a
 * double-quoted word as a string literal rather than as an identifier — which
 * is the whole reason this file exists.
 */
const MYSQL_WRITER: RescueWriter = {
  ...SQL_WRITER,
  engine: 'mysql',

  hasValue: (column) => `${backtick(column)} IS NOT NULL`,

  byKey: (key) =>
    Object.keys(key)
      .map((name) =>
        key[name] === null || key[name] === undefined
          ? `${backtick(name)} IS NULL`
          : `${backtick(name)} = ${literal(key[name])}`,
      )
      .join(' AND '),

  insert: (table, row) => {
    const columns = Object.keys(row);
    return (
      `INSERT INTO ${backtick(table)} (${columns.map(backtick).join(', ')}) VALUES ` +
      `(${columns.map((column) => literal(row[column])).join(', ')});`
    );
  },

  restore: (table, columns, row, keys) => {
    if (keys.length === 0) {
      return `-- no primary key on ${table}; this row cannot be addressed: ${JSON.stringify(row)}`;
    }
    const assignments = columns
      .map((column) => `${backtick(column)} = ${literal(row[column])}`)
      .join(', ');
    const where = keys
      .map((key) =>
        row[key] === null || row[key] === undefined
          ? `${backtick(key)} IS NULL`
          : `${backtick(key)} = ${literal(row[key])}`,
      )
      .join(' AND ');

    return `UPDATE ${backtick(table)} SET ${assignments} WHERE ${where};`;
  },
};

const MONGO_WRITER: RescueWriter = {
  engine: 'mongo',
  comment: '//',
  noun: 'operations',

  // Filters here are JSON, which is what the adapter parses them as. A missing
  // field and a null one are different things in MongoDB, and both mean "no
  // value here" for this question — so the rows worth keeping are the ones
  // where the field is present *and* not null.
  hasValue: (column) => JSON.stringify({ [column]: { $exists: true, $ne: null } }),

  byKey: (key) => JSON.stringify(key),

  insert: (table, row) =>
    `db.getCollection(${JSON.stringify(table)}).insertOne(${mongoValue(row)});`,

  restore: (table, columns, row, keys) => {
    if (keys.length === 0) {
      return `// no key on ${table}; this document cannot be addressed: ${JSON.stringify(row)}`;
    }

    const filter: Row = {};
    for (const key of keys) {
      filter[key] = row[key] ?? null;
    }

    const set: Row = {};
    for (const column of columns) {
      set[column] = row[column] ?? null;
    }

    return (
      `db.getCollection(${JSON.stringify(table)})` +
      `.updateOne(${mongoValue(filter)}, { $set: ${mongoValue(set)} });`
    );
  },
};

export function rescueWriterFor(engine: Engine): RescueWriter {
  if (engine === 'mongo') {
    return MONGO_WRITER;
  }
  return engine === 'mysql' ? MYSQL_WRITER : SQL_WRITER;
}

function backtick(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * A value as it would be written in mongosh.
 *
 * Dates become `ISODate(…)` rather than a quoted string: a rescue file that
 * puts a date back as text has restored something else.
 */
function mongoValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value instanceof Date) {
    return `ISODate(${JSON.stringify(value.toISOString())})`;
  }
  if (Buffer.isBuffer(value)) {
    return `BinData(0, ${JSON.stringify(value.toString('base64'))})`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(mongoValue).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([name, held]) => `${JSON.stringify(name)}: ${mongoValue(held)}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(String(value));
}
