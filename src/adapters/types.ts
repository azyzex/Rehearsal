/**
 * Engine-agnostic contract. Nothing above `adapters/` may contain Postgres-specific SQL.
 */

export type Engine = "postgres" | "mysql" | "mongo";

export interface ConnectionConfig {
  /** Full connection string. Never persisted anywhere by this extension. */
  readonly connectionString: string;
  /** statement_timeout applied inside every preview transaction, in milliseconds. */
  readonly statementTimeoutMs: number;
  /** lock_timeout applied inside every preview transaction, in milliseconds. */
  readonly lockTimeoutMs: number;
  /** Reported to the server so a DBA can identify and kill these sessions. */
  readonly applicationName: string;
}

export type Row = Record<string, unknown>;

export interface QueryResult {
  readonly rows: Row[];
  /** Rows affected, as reported by the driver. Null for statements that do not report one. */
  readonly rowCount: number | null;
}

/**
 * A handle to a transaction that is guaranteed to be rolled back.
 *
 * `query` refuses transaction-control statements. This is not defensive
 * paranoia: the statements passed here come out of user migration files,
 * and a file containing a literal `COMMIT;` would otherwise persist
 * everything the preview just did.
 */
export interface Transaction {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;

  /**
   * Marks a point to come back to. Analysis uses this to run a statement, look
   * at the result, and undo just that statement while staying in the same
   * transaction.
   *
   * Savepoints are exposed as two narrow methods rather than as a general
   * bypass of `query`'s screening, so that there is still no code path in the
   * codebase capable of issuing a COMMIT. `name` must be a bare identifier.
   */
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
}

export interface TableStats {
  readonly schema: string;
  readonly table: string;
  /** Planner estimate from the catalog. Cheap, and approximate — label it as such in the UI. */
  readonly estimatedRows: number;
  /** Total on-disk size in bytes, including indexes and TOAST. */
  readonly totalBytes: number;
}

export interface QueryPlan {
  readonly raw: unknown;
}

export interface ColumnInfo {
  readonly name: string;
  /** As Postgres renders it: `text`, `character varying(20)`, `timestamptz`. */
  readonly type: string;
  readonly nullable: boolean;
  readonly isPrimaryKey: boolean;
}

export interface ForeignKeyInfo {
  readonly name: string;
  readonly fromTable: string;
  readonly fromColumns: readonly string[];
  readonly toTable: string;
  readonly toColumns: readonly string[];
}

export interface SchemaTable {
  readonly schema: string;
  readonly name: string;
  /** `schema.name`, or just `name` when it lives in the default schema. */
  readonly qualified: string;
  readonly rows: number;
  readonly bytes: number;
  readonly columns: readonly ColumnInfo[];
  /** True for a partitioned parent table. */
  readonly partitioned: boolean;
}

/**
 * Everything needed to draw the database. Read in a fixed number of queries
 * regardless of how many tables there are — a per-table round trip is fine for
 * the three tables a migration touches and unusable for the two hundred a real
 * schema holds.
 */
export interface SchemaSnapshot {
  readonly tables: readonly SchemaTable[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
  /** Schemas that were found, in the order they should be offered. */
  readonly schemas: readonly string[];
}

export interface IndexInfo {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
  readonly definition: string;
}

export interface ConstraintInfo {
  readonly name: string;
  readonly type:
    "primary key" | "foreign key" | "unique" | "check" | "exclusion" | "other";
  readonly definition: string;
}

/** Everything the table drawer shows: structure, rules, and actual rows. */
export interface TableDetail {
  readonly table: string;
  readonly columns: readonly ColumnInfo[];
  readonly indexes: readonly IndexInfo[];
  readonly constraints: readonly ConstraintInfo[];
  readonly primaryKey: readonly string[];
  readonly rows: number;
  /** True when `rows` is the planner's estimate because counting timed out. */
  readonly rowsEstimated: boolean;
  readonly sample: readonly Row[];
  /** The filter the sample was taken under, when one was given. */
  readonly filter?: string;
  /** How many rows the filter matched, capped at the sample limit. */
  readonly matched?: number;
}

/** A session already holding a lock on a table. */
export interface LockHolder {
  readonly pid: number;
  /** `active`, `idle in transaction`, and so on. */
  readonly state: string;
  readonly applicationName: string;
  readonly query: string;
  /** How long it has been in that state. */
  readonly seconds: number;
  readonly lockMode: string;
}

/**
 * One table in a cascade, and what a delete would take from it.
 *
 * `ON DELETE CASCADE` removes rows from tables the statement never mentions,
 * and `ON DELETE SET NULL` quietly blanks columns instead. Both are invisible
 * in the statement text and only countable against the real data.
 */
export interface CascadeNode {
  readonly table: string;
  readonly rows: number;
  /** How the parent reaches it. Absent on the root. */
  readonly via?: {
    readonly constraint: string;
    readonly action: CascadeAction;
  };
  readonly children: readonly CascadeNode[];
  /** Set when the walk stopped early rather than finishing. */
  readonly truncated?: string;
}

export type CascadeAction =
  "cascade" | "set null" | "set default" | "restrict" | "no action";

/**
 * What an index would do to a query, measured rather than guessed.
 *
 * Two ways to find out, and the difference between them is the whole point.
 * A hypothetical index exists only in the planner's head: it costs nothing to
 * create, takes no lock, touches no disk, and answers "would the planner even
 * use this" in milliseconds against production-shaped statistics. Building the
 * index for real inside a rolled-back transaction answers the same question
 * and also gives real timings — at the price of actually building it, which
 * on a large table blocks writes for as long as it takes.
 */
export interface IndexExperiment {
  readonly method: "hypothetical" | "built";
  readonly before: QueryPlan;
  readonly after: QueryPlan;
  /** Whether the planner reached for the new index. The only question that matters. */
  readonly used: boolean;
  readonly beforeCost: number;
  readonly afterCost: number;
  /** Measured milliseconds. Only the `built` method can produce these. */
  readonly beforeMs?: number;
  readonly afterMs?: number;
  /** Anything the caller has to say about the numbers before trusting them. */
  readonly note?: string;
}

/** Thrown when the no-lock path is unavailable and the caller did not permit the other one. */
export class HypotheticalIndexUnavailableError extends Error {
  constructor() {
    super(
      "Testing an index without building it needs the hypopg extension: " +
        "CREATE EXTENSION hypopg; The alternative is to build the index for real " +
        "inside a transaction that is rolled back, which measures the same thing " +
        "but takes a lock while it builds.",
    );
    this.name = "HypotheticalIndexUnavailableError";
  }
}

/**
 * The state of the schema itself, as opposed to what a statement would do to it.
 *
 * Every number here comes from the statistics collector, which means every
 * number here is measured over a window rather than for all time. That window
 * is reported alongside them and is not a footnote: "this index has never been
 * scanned" and "this index has not been scanned since the server restarted
 * ninety minutes ago" are the same row of `pg_stat_user_indexes` and completely
 * different facts.
 */
export interface SchemaHealth {
  /** When the statistics being read were last reset. Null when unknown. */
  readonly statsSince: Date | null;
  readonly unusedIndexes: readonly UnusedIndex[];
  readonly redundantIndexes: readonly RedundantIndex[];
  readonly unindexedForeignKeys: readonly UnindexedForeignKey[];
  readonly tables: readonly TableHealth[];
}

export interface UnusedIndex {
  readonly table: string;
  readonly index: string;
  /** Scans since the statistics window began. */
  readonly scans: number;
  readonly bytes: number;
  readonly definition: string;
}

/**
 * An index whose columns are a leading subset of another index on the same
 * table. Anything the shorter one answers, the longer one answers too.
 */
export interface RedundantIndex {
  readonly table: string;
  readonly index: string;
  readonly coveredBy: string;
  readonly bytes: number;
}

/**
 * A foreign key with no index on the referencing side.
 *
 * Deleting a parent row makes the database look for children, and with no index
 * that is a sequential scan of the child table per deleted row — while holding
 * a lock. It is also why a delete that "should be instant" takes minutes.
 */
export interface UnindexedForeignKey {
  readonly constraint: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  /** Rows in the referencing table, which is what decides whether this matters. */
  readonly rows: number;
}

export interface TableHealth {
  readonly table: string;
  readonly liveRows: number;
  readonly deadRows: number;
  /** Rows changed since the planner's statistics were last refreshed. */
  readonly modifiedSinceAnalyze: number;
  readonly lastVacuum: Date | null;
  readonly lastAnalyze: Date | null;
  readonly bytes: number;
}

export type PrimaryKeyValue = Record<string, unknown>;

export interface DatabaseAdapter {
  readonly engine: Engine;
  readonly supportsTransactionalDDL: boolean;

  connect(config: ConnectionConfig): Promise<void>;
  dispose(): Promise<void>;

  /**
   * Runs `fn` inside a transaction that is ALWAYS rolled back, including when
   * `fn` throws. No implementation may ever commit.
   */
  withRollback<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  // Read-only probes. These never modify anything and run outside a transaction.
  /**
   * Rows matching `where`, which may carry bound placeholders. The visual
   * editor generates predicates containing `$1`, so a counter unable to take
   * parameters would fail on exactly the statements it generated.
   */
  countRows(
    table: string,
    where?: string,
    params?: readonly unknown[],
  ): Promise<number>;
  countNonNull(table: string, column: string): Promise<number>;
  countViolating(table: string, predicate: string): Promise<number>;
  /** Rows in `table` whose `columns` do not match any row in the referenced table. */
  countOrphans(
    table: string,
    columns: readonly string[],
    referencedTable: string,
    referencedColumns: readonly string[],
  ): Promise<number>;
  /** How many duplicate groups exist over `columns`, and how many rows they cover. */
  countDuplicates(
    table: string,
    columns: readonly string[],
  ): Promise<{ groups: number; rows: number }>;
  /**
   * Rows that would fail to cast to `newType`. Returns null when the cast
   * cannot be tested at all — reported as unverifiable rather than as zero.
   */
  countCastFailures(
    table: string,
    column: string,
    newType: string,
  ): Promise<number | null>;
  tableStats(table: string): Promise<TableStats>;
  sampleRows(
    table: string,
    pks: PrimaryKeyValue[],
    limit: number,
  ): Promise<Row[]>;
  primaryKeyColumns(table: string): Promise<string[]>;
  /** Columns in declaration order, for drawing the table. */
  tableColumns(table: string): Promise<ColumnInfo[]>;
  /** Foreign keys with either end among `tables`. */
  foreignKeys(tables: readonly string[]): Promise<ForeignKeyInfo[]>;
  /** The whole database: every table, column and relationship. */
  schemaSnapshot(): Promise<SchemaSnapshot>;
  /**
   * One table in full, with a sample of real rows.  matches any column
   * cast to text, case-insensitively — for finding one row among many.
   */
  tableDetail(
    table: string,
    sampleLimit: number,
    filter?: string,
  ): Promise<TableDetail>;

  /**
   * Rows matching a predicate.
   *
   * The rows behind a blocking count: which twelve have no email, which two
   * hundred are orphaned. Read-only and bounded. `orderBy` exists for
   * duplicates, whose groups are invisible unless their members sit together.
   */
  rowsMatching(
    table: string,
    where: string,
    limit: number,
    orderBy?: string,
  ): Promise<Row[]>;

  /**
   * Sessions holding a lock on `table` right now.
   *
   * The difference between "this takes one second" and "this takes one second
   * once the fourteen-minute report ahead of it finishes, with every query that
   * arrives in the meantime queued behind you".
   */
  lockHolders(table: string): Promise<LockHolder[]>;

  /**
   * Rows in each table that a delete from `table` would cascade to.
   *
   * ON DELETE CASCADE removes rows from tables the statement never names, and
   * the only way to know how many is to walk the foreign keys and count.
   */
  cascadeImpact(
    table: string,
    where: string,
    params: readonly unknown[],
  ): Promise<CascadeNode>;

  /**
   * Applies previewed statements for real, in one transaction. The only write
   * path on the adapter; see adapters/commit.ts for why it is isolated.
   */
  runCommitted(
    statements: readonly { sql: string; params: readonly unknown[] }[],
  ): Promise<{ applied: number; rowCounts: readonly (number | null)[] }>;
  /**
   * A plan for the statement. Takes bound parameters because the statements
   * the visual editor generates carry them, and a planner has to be given the
   * same values it would really run with.
   */
  explain(
    sql: string,
    analyze: boolean,
    params?: readonly unknown[],
  ): Promise<QueryPlan>;

  /**
   * The health of the schema itself: indexes nothing reads, indexes another
   * index already covers, foreign keys with no index behind them, and how
   * stale each table's statistics are.
   */
  schemaHealth(): Promise<SchemaHealth>;

  /** Whether indexes can be tested without building them. */
  supportsHypotheticalIndexes(): Promise<boolean>;

  /**
   * What `indexSql` would do to `query`.
   *
   * Prefers the hypothetical path, which takes no lock and writes nothing. When
   * that is unavailable it either refuses or builds the index inside a
   * rolled-back transaction, depending on `build` — never silently, because the
   * two have very different costs on a large table.
   */
  testIndex(
    indexSql: string,
    query: string,
    params: readonly unknown[],
    options: { readonly build: boolean },
  ): Promise<IndexExperiment>;
}

/** Thrown when a caller tries to smuggle transaction control into a preview. */
export class TransactionControlError extends Error {
  constructor(public readonly statement: string) {
    super(
      `Dry Run refuses to execute transaction-control statements inside a preview ` +
        `(found: ${statement}). Committing would defeat the entire point of the preview.`,
    );
    this.name = "TransactionControlError";
  }
}
