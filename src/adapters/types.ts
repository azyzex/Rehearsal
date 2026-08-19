/**
 * Engine-agnostic contract. Nothing above `adapters/` may contain Postgres-specific SQL.
 */

export type Engine = 'postgres' | 'mysql' | 'mongo';

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
  countRows(table: string, where?: string): Promise<number>;
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
  countCastFailures(table: string, column: string, newType: string): Promise<number | null>;
  tableStats(table: string): Promise<TableStats>;
  sampleRows(table: string, pks: PrimaryKeyValue[], limit: number): Promise<Row[]>;
  primaryKeyColumns(table: string): Promise<string[]>;
  explain(sql: string, analyze: boolean): Promise<QueryPlan>;
}

/** Thrown when a caller tries to smuggle transaction control into a preview. */
export class TransactionControlError extends Error {
  constructor(public readonly statement: string) {
    super(
      `Dry Run refuses to execute transaction-control statements inside a preview ` +
        `(found: ${statement}). Committing would defeat the entire point of the preview.`,
    );
    this.name = 'TransactionControlError';
  }
}
