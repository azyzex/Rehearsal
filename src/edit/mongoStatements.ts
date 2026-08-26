import { Edit, GeneratedStatement, describeEdit } from './changeset';

/**
 * The visual editor's changes, written the way MongoDB writes them.
 *
 * Until this existed, `toStatement` produced SQL for every engine, so a MongoDB
 * user pressing Export got `ALTER TABLE users DROP COLUMN phone` about a
 * database with no tables and no columns — a file that cannot run anywhere,
 * offered as the thing to keep and review. The pending-changes list said the
 * same thing, and so did the route between two collections.
 *
 * The vocabulary maps over more cleanly than it looks, because the editor's
 * edits are already about intent rather than syntax: dropping a field is
 * `$unset`, renaming one is `$rename`, dropping a table is `drop()`.
 *
 * Three of them do not map at all, and those throw rather than inventing
 * something. MongoDB has no column defaults, no nullability to declare and no
 * foreign keys, so there is no honest statement to write — and a wrong one
 * would be worse than a refusal, because it would be exported, reviewed and
 * run. The editor does not offer those three when it is connected here.
 */

/** Statements are shell syntax: what you would paste into `mongosh`. */
export function toMongoStatement(edit: Edit, editIndex: number): GeneratedStatement {
  const label = describeEdit(edit);
  const make = (sql: string): GeneratedStatement => ({ sql, params: [], label, editIndex });

  // `db.getCollection('x')` rather than `db.x`, because a collection may be
  // named `stats` or `find` or anything else that collides with a method on the
  // database object, and the bracket form is what the shell itself recommends.
  const on = (collection: string): string => `db.getCollection(${quote(collection)})`;

  switch (edit.kind) {
    case 'add_column': {
      // There is no schema to add a field to. Adding one is only a real
      // operation when it has a value, and then it is a backfill.
      if (edit.defaultExpression === undefined || edit.defaultExpression === null) {
        throw new Error(
          `MongoDB has no schema to add "${edit.column}" to — a field exists once a document ` +
            `has it. Give it a value to backfill onto every document instead.`,
        );
      }
      return make(
        `${on(edit.table)}.updateMany(\n` +
          `  { ${field(edit.column)}: { $exists: false } },\n` +
          `  { $set: { ${field(edit.column)}: ${literal(edit.defaultExpression)} } }\n)`,
      );
    }

    case 'drop_column':
      return make(
        `${on(edit.table)}.updateMany({}, { $unset: { ${field(edit.column)}: "" } })`,
      );

    case 'rename_column':
      return make(
        `${on(edit.table)}.updateMany({}, { $rename: { ${field(edit.column)}: ${quote(edit.to)} } })`,
      );

    case 'alter_type': {
      // An aggregation pipeline update, which is the only way to compute a new
      // value from the old one. `onError` keeps a document that cannot convert
      // rather than writing null over it — losing the value would be a strange
      // thing for a type change to do.
      const operator = convertOperator(edit.to);
      return make(
        `${on(edit.table)}.updateMany({}, [\n` +
          `  { $set: { ${field(edit.column)}: { $convert: { input: ${path(edit.column)}, ` +
          `to: ${quote(operator)}, onError: ${path(edit.column)} } } } }\n])`,
      );
    }

    case 'add_index': {
      // `concurrently` has no counterpart: MongoDB builds indexes in the
      // background by default and has since 4.2, so there is no flag to carry
      // and nothing is lost by dropping it.
      const options: string[] = [];
      if (edit.unique) {
        options.push('unique: true');
      }
      if (edit.name) {
        options.push(`name: ${quote(edit.name)}`);
      }

      return make(
        `${on(edit.table)}.createIndex({ ${keySpec(edit.columns)} }` +
          `${options.length > 0 ? `, { ${options.join(', ')} }` : ''})`,
      );
    }

    case 'add_unique':
      return make(
        `${on(edit.table)}.createIndex({ ${keySpec(edit.columns)} }, { unique: true })`,
      );

    case 'drop_constraint':
      return make(`${on(edit.table)}.dropIndex(${quote(edit.name)})`);

    case 'rename_table':
      return make(`${on(edit.table)}.renameCollection(${quote(edit.to)})`);

    case 'drop_table':
      return make(`${on(edit.table)}.drop()`);

    case 'create_table':
      // Collections are created by the first insert, so this is only worth
      // saying explicitly — which is exactly what `createCollection` is for.
      return make(`db.createCollection(${quote(edit.table)})`);

    case 'update_row': {
      const entries = Object.entries(edit.set);
      if (entries.length === 0) {
        throw new Error('An update needs at least one field to change.');
      }
      const set = entries.map(([name, value]) => `${field(name)}: ${literal(value)}`).join(', ');
      return make(`${on(edit.table)}.updateOne(${filter(edit.key)}, { $set: { ${set} } })`);
    }

    case 'delete_row':
      return make(`${on(edit.table)}.deleteOne(${filter(edit.key)})`);

    case 'insert_row': {
      const entries = Object.entries(edit.values);
      if (entries.length === 0) {
        throw new Error('An insert needs at least one value.');
      }
      const document = entries
        .map(([name, value]) => `${field(name)}: ${literal(value)}`)
        .join(', ');
      return make(`${on(edit.table)}.insertOne({ ${document} })`);
    }

    // The three with no MongoDB equivalent. Refused by name, with the reason,
    // rather than approximated.
    case 'set_nullability':
      throw new Error(
        'MongoDB does not declare nullability. A field is absent, null, or has a value, and ' +
          'nothing enforces which — the nearest equivalent is a JSON Schema validator on the ' +
          'collection, which is a different change from the one this button makes.',
      );

    case 'set_default':
      throw new Error(
        'MongoDB has no column defaults. A default here is something the application writes ' +
          'when it inserts, not something the database holds.',
      );

    case 'add_foreign_key':
      throw new Error(
        'MongoDB has no foreign keys. The relationship between two collections is a convention ' +
          'the application keeps, which is why Dry Run infers the ones it draws rather than ' +
          'reading them.',
      );

    case 'add_check':
      throw new Error(
        'MongoDB has no check constraints. The nearest equivalent is a JSON Schema validator ' +
          'applied with collMod, which is a different change from the one this button makes.',
      );

    default:
      throw new Error(`Unsupported change: ${JSON.stringify(edit)}`);
  }
}

/** The changeset as a script someone could read, review and run in mongosh. */
export function toMongoScript(statements: readonly GeneratedStatement[]): string {
  return statements
    .map((statement) => `// ${statement.label}\n${statement.sql};`)
    .join('\n\n');
}

/**
 * A filter matching one document by its key.
 *
 * An empty key would be `{}` and match the whole collection, so it is refused
 * for the same reason the SQL side refuses a missing WHERE.
 */
function filter(key: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(key);
  if (entries.length === 0) {
    throw new Error('Editing one document needs a key that identifies it.');
  }
  return `{ ${entries.map(([name, value]) => `${field(name)}: ${literal(value)}`).join(', ')} }`;
}

/** `{ a: 1, b: 1 }` — an ascending index on each field, which is the default. */
function keySpec(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new Error('An index needs at least one field.');
  }
  return columns.map((column) => `${field(column)}: 1`).join(', ');
}

/**
 * A field name as a key.
 *
 * Always quoted. Dotted paths are how MongoDB addresses a nested field, and
 * `profile.preferences.theme: 1` is a syntax error unquoted.
 */
function field(name: string): string {
  return quote(name);
}

/** `"$profile.theme"` — a field *reference*, for aggregation expressions. */
function path(name: string): string {
  return quote(`$${name}`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * A value, written the way it would appear in the shell.
 *
 * Dates become `ISODate("…")` rather than a string, because a string is a
 * different type and would silently change what the document holds.
 */
function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value instanceof Date) {
    return `ISODate(${quote(value.toISOString())})`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return quote(String(value));
}

/**
 * The BSON type name `$convert` takes, from whatever the user typed.
 *
 * They are typing into a box that says "change this field to", and the words
 * people reach for are SQL's. `text` and `varchar` mean `string` here; `int4`
 * and `integer` mean `int`. Anything unrecognised is passed through, because
 * `$convert` knows more type names than this list does and an error from the
 * server naming the real problem beats a guess from here.
 */
function convertOperator(type: string): string {
  const normalised = type.trim().toLowerCase().replace(/\(.*\)$/, '');

  const known: Record<string, string> = {
    text: 'string',
    varchar: 'string',
    char: 'string',
    string: 'string',
    int: 'int',
    int4: 'int',
    integer: 'int',
    smallint: 'int',
    bigint: 'long',
    int8: 'long',
    long: 'long',
    numeric: 'decimal',
    decimal: 'decimal',
    real: 'double',
    float: 'double',
    float8: 'double',
    'double precision': 'double',
    double: 'double',
    bool: 'bool',
    boolean: 'bool',
    date: 'date',
    timestamp: 'date',
    timestamptz: 'date',
    objectid: 'objectId',
  };

  return known[normalised] ?? type.trim();
}
