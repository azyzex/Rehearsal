import { Classification, StatementKind } from './classifier';

/**
 * Reading a MongoDB migration.
 *
 * There is no SQL here, and no standard migration format either — a Mongo
 * migration is usually a JavaScript file. Running arbitrary JavaScript to find
 * out what it would do is exactly the thing this extension exists not to do, so
 * this reads the subset that is actually declarative and refuses the rest:
 *
 *     db.users.updateMany({ tier: "free" }, { $set: { tier: "basic" } })
 *     db.orders.deleteMany({ createdAt: { $lt: "2024-01-01" } })
 *     db.users.createIndex({ email: 1 }, { unique: true })
 *     db.sessions.drop()
 *
 * That is the shape mongosh scripts and migrate-mongo migrations take when they
 * are doing the thing a migration does, and it covers every operation whose
 * consequences can be measured. Anything with a variable, a loop or a callback
 * in it is reported as unreadable rather than guessed at — a wrong reading here
 * would produce a confident number about the wrong documents.
 *
 * The arguments are relaxed JSON: unquoted keys, single quotes and trailing
 * commas, because that is how people write them. Parsed properly rather than
 * with a regular expression, because `{ note: "}" }` is valid and a regex that
 * counts braces gets it wrong.
 */

export interface MongoStatement {
  readonly collection: string;
  readonly operation: string;
  readonly args: readonly unknown[];
  /** The statement as written, for showing in the panel. */
  readonly source: string;
}

export interface MongoClassification extends Classification {
  /** Absent when the statement could not be read. */
  readonly mongo?: MongoStatement;
  /** Why it could not be read, when it could not. */
  readonly unreadable?: string;
}

/**
 * Splits a migration into statements.
 *
 * A statement ends at a semicolon, or at a newline that closes a balanced
 * expression — so a call spread over several lines stays one statement.
 * Offsets are carried through because the panel jumps to a line when a row is
 * clicked, and a statement with no position is a row that goes nowhere.
 */
export function splitMongo(source: string): MongoSplit[] {
  const statements: MongoSplit[] = [];
  let current = '';
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  const flush = (end: number): void => {
    const text = current.trim();
    if (text.length === 0) {
      current = '';
      return;
    }
    // The trimmed statement sits somewhere inside what was collected, and the
    // panel highlights what it points at.
    const leading = current.length - current.trimStart().length;
    statements.push({
      index: statements.length,
      sql: text,
      startOffset: start + leading,
      endOffset: end,
    });
    current = '';
  };

  for (let i = 0; i < source.length; i += 1) {
    const character = source[i]!;

    if (current.length === 0 && !/\s/.test(character)) {
      start = i;
    }

    if (quote) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    // Comments are dropped rather than kept: they are not part of any
    // statement, and a `//` inside one would otherwise close it.
    if (character === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (character === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      current += character;
      continue;
    }

    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
    }

    if (depth === 0 && (character === ';' || character === '\n')) {
      flush(i);
      continue;
    }

    current += character;
  }

  flush(source.length);
  return statements;
}

/** One statement, with enough position for the panel to jump to it. */
export interface MongoSplit {
  readonly index: number;
  readonly sql: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

const CALL = /^db\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\2\s*\])\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/;

/** Reads one statement, or explains why it cannot. */
export function parseMongo(source: string): MongoStatement | { unreadable: string } {
  const text = source.trim().replace(/;\s*$/, '');
  const match = CALL.exec(text);

  if (!match) {
    return {
      unreadable:
        'Not a collection operation. Dry Run reads statements of the form ' +
        'db.<collection>.<operation>({ … }).',
    };
  }

  const collection = match[1] ?? match[3]!;
  const operation = match[4]!;
  const rest = text.slice(match[0].length);

  let args: unknown[];
  try {
    args = parseArguments(rest);
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }

  return { collection, operation, args, source: text };
}

/** Everything up to the closing paren, as a list of values. */
function parseArguments(text: string): unknown[] {
  const reader = new Reader(text);
  const args: unknown[] = [];

  reader.skipSpace();
  if (reader.peek() === ')') {
    return args;
  }

  for (;;) {
    args.push(reader.value());
    reader.skipSpace();
    const next = reader.next();
    if (next === ')') {
      return args;
    }
    if (next !== ',') {
      throw new Error(`Expected , or ) but found ${next ?? 'the end of the statement'}.`);
    }
    reader.skipSpace();
    // A trailing comma before the closing paren.
    if (reader.peek() === ')') {
      reader.next();
      return args;
    }
  }
}

/**
 * A reader for the relaxed JSON people actually write.
 *
 * Handles unquoted keys, single quotes and trailing commas, and refuses
 * anything that is really JavaScript — a variable, a function call, an
 * expression — rather than guessing what it would evaluate to.
 */
class Reader {
  private at = 0;

  constructor(private readonly text: string) {}

  skipSpace(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) {
      this.at += 1;
    }
  }

  peek(): string | undefined {
    this.skipSpace();
    return this.text[this.at];
  }

  next(): string | undefined {
    this.skipSpace();
    const character = this.text[this.at];
    this.at += 1;
    return character;
  }

  value(): unknown {
    this.skipSpace();
    const character = this.text[this.at];

    if (character === '{') {
      return this.object();
    }
    if (character === '[') {
      return this.array();
    }
    if (character === '"' || character === "'") {
      return this.string();
    }
    return this.literal();
  }

  private object(): Record<string, unknown> {
    this.at += 1; // {
    const result: Record<string, unknown> = {};

    this.skipSpace();
    if (this.text[this.at] === '}') {
      this.at += 1;
      return result;
    }

    for (;;) {
      this.skipSpace();
      const key =
        this.text[this.at] === '"' || this.text[this.at] === "'" ? this.string() : this.key();

      this.skipSpace();
      if (this.text[this.at] !== ':') {
        throw new Error(`Expected : after ${JSON.stringify(key)}.`);
      }
      this.at += 1;

      result[key] = this.value();

      this.skipSpace();
      const separator = this.text[this.at];
      this.at += 1;

      if (separator === '}') {
        return result;
      }
      if (separator !== ',') {
        throw new Error('Expected , or } inside an object.');
      }
      this.skipSpace();
      if (this.text[this.at] === '}') {
        this.at += 1;
        return result;
      }
    }
  }

  private array(): unknown[] {
    this.at += 1; // [
    const result: unknown[] = [];

    this.skipSpace();
    if (this.text[this.at] === ']') {
      this.at += 1;
      return result;
    }

    for (;;) {
      result.push(this.value());
      this.skipSpace();
      const separator = this.text[this.at];
      this.at += 1;

      if (separator === ']') {
        return result;
      }
      if (separator !== ',') {
        throw new Error('Expected , or ] inside an array.');
      }
      this.skipSpace();
      if (this.text[this.at] === ']') {
        this.at += 1;
        return result;
      }
    }
  }

  private string(): string {
    const quote = this.text[this.at]!;
    this.at += 1;
    let out = '';

    while (this.at < this.text.length) {
      const character = this.text[this.at]!;
      this.at += 1;

      if (character === '\\') {
        const escape = this.text[this.at]!;
        this.at += 1;
        out += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape;
        continue;
      }
      if (character === quote) {
        return out;
      }
      out += character;
    }
    throw new Error('A quoted string is never closed.');
  }

  private key(): string {
    const match = /^[A-Za-z_$][\w$.]*/.exec(this.text.slice(this.at));
    if (!match) {
      throw new Error('Expected a field name.');
    }
    this.at += match[0].length;
    return match[0];
  }

  private literal(): unknown {
    const rest = this.text.slice(this.at);

    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) {
      this.at += number[0].length;
      return Number(number[0]);
    }

    const word = /^(true|false|null)\b/.exec(rest);
    if (word) {
      this.at += word[0].length;
      return word[0] === 'true' ? true : word[0] === 'false' ? false : null;
    }

    // Anything else is JavaScript: a variable, a call, an expression. Refused
    // rather than guessed at — a wrong reading produces a confident number
    // about the wrong documents.
    const offending = /^[^,)\]}\s]+/.exec(rest)?.[0] ?? rest.slice(0, 20);
    throw new Error(
      `Cannot read ${JSON.stringify(offending)}. Dry Run reads literal values only, ` +
        `so that it never has to run your migration to find out what it means.`,
    );
  }
}

/** Operations that change documents, and are previewed by running them. */
const WRITES: Record<string, StatementKind> = {
  updateMany: 'update',
  updateOne: 'update',
  replaceOne: 'update',
  findOneAndUpdate: 'update',
  deleteMany: 'delete',
  deleteOne: 'delete',
  findOneAndDelete: 'delete',
  remove: 'delete',
  insertMany: 'insert',
  insertOne: 'insert',
  save: 'insert',
};

/** Operations that change the collection, and are probed rather than run. */
const STRUCTURE: Record<string, StatementKind> = {
  createIndex: 'create_index',
  createIndexes: 'create_index',
  drop: 'drop_table',
  renameCollection: 'rename_table',
  createCollection: 'create_table',
};

/**
 * What a statement is, in the vocabulary the rest of the extension speaks.
 *
 * The mapping is closer than it looks. A `$unset` applied across a collection
 * is exactly a DROP COLUMN — it removes a field from every document that has
 * one — and treating it as such means the existing analysis counts how many
 * documents are about to lose a value, which is the question anyone asks.
 */
export function classifyMongo(source: string): MongoClassification {
  const parsed = parseMongo(source);

  if ('unreadable' in parsed) {
    return { kind: 'other', unreadable: parsed.unreadable };
  }

  const { collection, operation, args } = parsed;
  const base = { table: collection, mongo: parsed };

  const structure = STRUCTURE[operation];
  if (structure) {
    return {
      ...base,
      kind: structure,
      ...(structure === 'create_index' ? { columns: indexFields(args[0]) } : {}),
    };
  }

  const write = WRITES[operation];
  if (!write) {
    return {
      ...base,
      kind: 'other',
      unreadable:
        `Dry Run does not know what ${operation}() would do. It reads the operations ` +
        `that change documents or the collection.`,
    };
  }

  const filter = args[0];
  const hasWhere = isObject(filter) && Object.keys(filter).length > 0;

  // An update whose only operator is $unset removes a field from every document
  // it matches, which is the same event as dropping a column.
  const unset = unsetField(args[1]);
  if (write === 'update' && unset) {
    return { ...base, kind: 'drop_column', column: unset, hasWhere };
  }

  return { ...base, kind: write, ...(write === 'insert' ? {} : { hasWhere }) };
}

/** The single field a `$unset` removes, when it removes exactly one. */
function unsetField(update: unknown): string | undefined {
  if (!isObject(update)) {
    return undefined;
  }
  const operators = Object.keys(update);
  if (operators.length !== 1 || operators[0] !== '$unset') {
    return undefined;
  }
  const fields = update['$unset'];
  if (!isObject(fields)) {
    return undefined;
  }
  const names = Object.keys(fields);
  return names.length === 1 ? names[0] : undefined;
}

function indexFields(keys: unknown): string[] {
  return isObject(keys) ? Object.keys(keys) : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
