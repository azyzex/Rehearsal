import { DatabaseAdapter, Engine } from '../adapters/types';
import {
  BACKTICK_QUOTING,
  Edit,
  GeneratedStatement,
  inlineParams,
  toStatement,
} from './changeset';
import { DownMigration, downMigration } from './down';
import { mongoDownMigration } from './mongoDown';
import { toMongoScript, toMongoStatement } from './mongoStatements';

/**
 * How an engine writes a change down.
 *
 * The counterpart to `parser/language.ts`, which answers the same question in
 * the other direction: that one reads a file someone wrote, this one writes a
 * file someone will read. Both exist because two of the three databases take
 * SQL and one does not, and until they did the pipeline simply assumed SQL
 * everywhere.
 *
 * The labels live here too. "Export SQL" on a MongoDB connection is a small
 * lie that gives away a large one — the file behind it really was SQL — and
 * putting the word next to the generator is what keeps the two from drifting
 * apart again.
 */
export interface EditDialect {
  readonly engine: Engine;

  /** What one change is called: "statement" or "operation". */
  readonly noun: string;

  /** The Export button, and the title of the document it opens. */
  readonly exportLabel: string;

  /** The Down button. */
  readonly downLabel: string;

  /** The language id for `openTextDocument`, so the file is coloured right. */
  readonly documentLanguage: string;

  /** The comment marker the generated file uses. */
  readonly comment: string;

  /** Turns one edit into the statement that performs it. */
  toStatement(edit: Edit, editIndex: number): GeneratedStatement;

  /** The whole changeset as a file someone could review and keep. */
  toScript(statements: readonly GeneratedStatement[]): string;

  /**
   * Whether this engine can declare a field nullable or not.
   *
   * The editor hides the Require / Allow null buttons where it cannot, rather
   * than offering something that has to refuse when pressed.
   */
  readonly hasNullability: boolean;

  /** Whether relationships can be declared, as opposed to inferred. */
  readonly hasForeignKeys: boolean;

  /** Whether a field can carry a default the database applies. */
  readonly hasDefaults: boolean;

  /**
   * Whether Dry Run can generate the migration that undoes a changeset here.
   *
   * True on all three now. It was false on MongoDB for exactly one commit,
   * while the alternative on offer was a SQL down migration.
   */
  readonly hasDownMigration: boolean;

  /** Builds the script that undoes a changeset, read against the live database. */
  downMigration(
    adapter: DatabaseAdapter,
    edits: readonly Edit[],
  ): Promise<DownMigration>;
}

const SQL: EditDialect = {
  engine: 'postgres',
  noun: 'statement',
  exportLabel: 'Export SQL',
  downLabel: 'Down SQL',
  documentLanguage: 'sql',
  comment: '--',
  toStatement,
  toScript: (statements) =>
    statements
      .map((statement) => `-- ${statement.label}\n${inlineParams(statement.sql, statement.params)};`)
      .join('\n\n'),
  hasNullability: true,
  hasForeignKeys: true,
  hasDefaults: true,
  hasDownMigration: true,
  downMigration,
};

/**
 * MySQL is SQL with different quotes, and getting that wrong is not cosmetic.
 *
 * Its default sql_mode reads `"users"` as the string 'users', so every
 * migration this exported for a MySQL user was a syntax error — offered as the
 * file to review and keep, and rejected the moment anyone ran it.
 */
const MYSQL: EditDialect = {
  ...SQL,
  engine: 'mysql',
  toStatement: (edit, editIndex) => toStatement(edit, editIndex, BACKTICK_QUOTING),
};

const MONGO: EditDialect = {
  engine: 'mongo',
  noun: 'operation',
  exportLabel: 'Export script',
  downLabel: 'Down script',
  // `javascript` rather than a MongoDB-specific id, because that is the one
  // every editor has: mongosh scripts are JavaScript, and the alternative is a
  // file with no colouring at all.
  documentLanguage: 'javascript',
  comment: '//',
  toStatement: toMongoStatement,
  toScript: toMongoScript,
  hasNullability: false,
  hasForeignKeys: false,
  hasDefaults: false,
  hasDownMigration: true,
  downMigration: mongoDownMigration,
};

export function dialectFor(engine: Engine): EditDialect {
  if (engine === 'mongo') {
    return MONGO;
  }
  return engine === 'mysql' ? MYSQL : SQL;
}
