import { SchemaSnapshot } from '../adapters/types';

/**
 * Where the Prisma schema and the database disagree.
 *
 * The schema file says what the application believes the database looks like;
 * the database is what it actually looks like. They drift — a hand-applied
 * fix in production, a migration that ran in one environment and not another,
 * a field made optional in code and never in the database — and the drift is
 * invisible until a query written against the file meets the table.
 *
 * Only what can be compared without guessing: tables, columns, and whether a
 * column may be null. Types are left out on purpose. Prisma's `String` is
 * text, varchar, char, uuid or citext depending on attributes and provider,
 * and a comparison that cries wolf on every one of them would be ignored by
 * the second run.
 *
 * Drizzle is not read: its schema is TypeScript, and reading it properly means
 * running it. Parsing it with patterns would be right most of the time and
 * confidently wrong the rest.
 */

export interface PrismaField {
  readonly name: string;
  /** The column, after `@map`. */
  readonly column: string;
  readonly optional: boolean;
}

export interface PrismaModel {
  readonly name: string;
  /** The table, after `@@map`. */
  readonly table: string;
  readonly fields: readonly PrismaField[];
}

const SCALARS = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes',
]);

/**
 * The models in a schema.prisma file, with their table and column names.
 *
 * Relation fields — a model's name as a type, or a list — are not columns and
 * are left out, as are `@ignore`d fields and `@@ignore`d models.
 */
export function parsePrisma(text: string): PrismaModel[] {
  const source = text.replace(/\/\/[^\n]*/g, '');
  const enums = new Set([...source.matchAll(/\benum\s+(\w+)\s*\{/g)].map((match) => match[1]!));
  const models: PrismaModel[] = [];

  for (const match of source.matchAll(/\bmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const name = match[1]!;
    const body = match[2]!;

    if (/@@ignore\b/.test(body)) {
      continue;
    }

    const table = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)?.[1] ?? name;
    const fields: PrismaField[] = [];

    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('@@')) {
        continue;
      }

      const field = /^(\w+)\s+(\w+(?:\([^)]*\))?)(\[\])?(\?)?(.*)$/.exec(line);
      if (!field) {
        continue;
      }

      const [, fieldName, type, , optional, rest] = field;
      const base = type!.replace(/\(.*\)$/, '');
      const scalar = SCALARS.has(base) || enums.has(base) || base === 'Unsupported';

      // A list of scalars is a Postgres array column; a list of models is a
      // relation, and so is a single model reference.
      if (!scalar || /@ignore\b/.test(rest ?? '')) {
        continue;
      }

      fields.push({
        name: fieldName!,
        column: /@map\(\s*"([^"]+)"\s*\)/.exec(rest ?? '')?.[1] ?? fieldName!,
        optional: Boolean(optional),
      });
    }

    models.push({ name, table, fields });
  }

  return models;
}

export interface Drift {
  readonly missingTables: readonly string[];
  readonly missingColumns: readonly string[];
  readonly extraColumns: readonly string[];
  /** `table.column`: what the schema says, and what the database says. */
  readonly nullability: readonly { column: string; schema: string; database: string }[];
}

export function compareWithPrisma(models: readonly PrismaModel[], snapshot: SchemaSnapshot): Drift {
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  const extraColumns: string[] = [];
  const nullability: { column: string; schema: string; database: string }[] = [];

  for (const model of models) {
    const wanted = model.table.toLowerCase();
    const table = snapshot.tables.find(
      (candidate) =>
        candidate.name.toLowerCase() === wanted || candidate.qualified.toLowerCase() === wanted,
    );

    if (!table) {
      missingTables.push(model.table);
      continue;
    }

    const columns = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
    const declared = new Set<string>();

    for (const field of model.fields) {
      const key = field.column.toLowerCase();
      declared.add(key);
      const column = columns.get(key);

      if (!column) {
        missingColumns.push(`${table.name}.${field.column}`);
        continue;
      }

      if (field.optional !== column.nullable) {
        nullability.push({
          column: `${table.name}.${column.name}`,
          schema: field.optional ? 'optional' : 'required',
          database: column.nullable ? 'nullable' : 'NOT NULL',
        });
      }
    }

    for (const column of table.columns) {
      if (!declared.has(column.name.toLowerCase())) {
        extraColumns.push(`${table.name}.${column.name}`);
      }
    }
  }

  return { missingTables, missingColumns, extraColumns, nullability };
}

/** The drift as a document someone can read top to bottom and act on. */
export function driftReport(drift: Drift, options: { schemaFile: string; connection: string }): string {
  const lines = [
    '# Prisma schema against the database',
    '',
    `**Schema:** ${options.schemaFile}  `,
    `**Database:** ${options.connection}`,
    '',
  ];

  const nothing =
    drift.missingTables.length === 0 &&
    drift.missingColumns.length === 0 &&
    drift.extraColumns.length === 0 &&
    drift.nullability.length === 0;

  if (nothing) {
    lines.push(
      'They agree: every model has its table, every field its column, and every column',
      'allows null exactly where the schema says it may. Types were not compared — see',
      'the note at the end.',
      '',
    );
  }

  const list = (title: string, why: string, items: readonly string[]): void => {
    if (items.length === 0) {
      return;
    }
    lines.push(`## ${title}`, '', why, '', ...items.map((item) => `- \`${item}\``), '');
  };

  list(
    'Models with no table',
    'The schema declares these and the database does not have them. Every query against one fails.',
    drift.missingTables,
  );
  list(
    'Fields with no column',
    'Any query that selects or writes one of these fails. Usually a migration that has not run here.',
    drift.missingColumns,
  );

  if (drift.nullability.length > 0) {
    lines.push(
      '## Null allowed in one place and not the other',
      '',
      'Where the schema says required and the database allows null, the application',
      'will meet a null its types say cannot exist. Where the schema says optional and',
      'the database says NOT NULL, the first write of a null fails.',
      '',
      '| Column | Schema | Database |',
      '| --- | --- | --- |',
      ...drift.nullability.map((entry) => `| \`${entry.column}\` | ${entry.schema} | ${entry.database} |`),
      '',
    );
  }

  list(
    'Columns the schema does not mention',
    'Harmless to Prisma, which ignores them, but worth knowing about: something else ' +
      'writes them, or nothing does.',
    drift.extraColumns,
  );

  lines.push(
    '---',
    '',
    'Types are not compared. Prisma\'s `String` can be text, varchar, char or uuid depending',
    'on attributes and provider, and a comparison that flags every one of those would be',
    'noise. Tables, columns and nullability are compared exactly.',
    '',
  );

  return lines.join('\n');
}
