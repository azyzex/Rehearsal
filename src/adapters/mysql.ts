import type { Connection } from 'mysql2/promise';
import {
  CascadeNode,
  ColumnInfo,
  ConnectionConfig,
  ConstraintInfo,
  DatabaseAdapter,
  ForeignKeyInfo,
  HypotheticalIndexUnavailableError,
  IndexExperiment,
  IndexInfo,
  LockHolder,
  PrimaryKeyValue,
  QueryPlan,
  QueryResult,
  Row,
  SchemaHealth,
  SchemaSnapshot,
  SchemaTable,
  TableDetail,
  TableStats,
  Transaction,
  TransactionControlError,
  TriggerInfo,
} from './types';
import { findTransactionControl } from '../parser/transactionControl';

/**
 * MySQL adapter.
 *
 * The interesting thing about MySQL is the thing it cannot do. Postgres has
 * transactional DDL: an ALTER inside a transaction is undone by a ROLLBACK
 * like anything else. MySQL does not. It performs an implicit commit before
 * *and* after every DDL statement, so an ALTER sent inside a transaction is
 * committed the instant it runs, and the ROLLBACK that follows undoes nothing.
 *
 * That is not a quirk to work around. It is the one assumption this entire
 * extension rests on, absent — so it is enforced rather than documented.
 * `withRollback` refuses DDL outright, the same way it refuses COMMIT, and for
 * the same reason: the statements passed to it come out of user migration
 * files, and a file containing an ALTER would otherwise apply it for real
 * while the panel said "nothing was committed".
 *
 * The good news, and it is genuinely good, is that nothing needs it to. DDL was
 * already analysed by counting rather than by executing — an index build takes
 * its full time and its full lock whether it is committed or not, so previewing
 * one would cause the outage the preview exists to prevent. Every DDL finding
 * on Postgres already comes from a read-only probe, and those probes work here
 * unchanged. What differs is what `Apply` can promise, and that is stated where
 * it matters rather than quietly weakened.
 */

/** Thrown when DDL is sent somewhere it cannot be undone. */
export class NonTransactionalDdlError extends Error {
  constructor(public readonly statement: string) {
    super(
      `MySQL commits DDL the moment it runs — an implicit commit happens before and ` +
        `after every ALTER, CREATE and DROP, so a ROLLBACK afterwards undoes nothing. ` +
        `Dry Run refuses to execute DDL here because it could not take it back ` +
        `(found: ${statement}). Its effects are measured by counting instead.`,
    );
    this.name = 'NonTransactionalDdlError';
  }
}

/**
 * Statements MySQL commits implicitly.
 *
 * Deliberately broad. Anything unrecognised is allowed through — that is what
 * `query` is for — but everything on this list is refused, because being wrong
 * in the permissive direction here means silently writing to someone's
 * database while telling them nothing happened.
 */
const IMPLICIT_COMMIT =
  /^\s*(ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|FLUSH|LOCK\s+TABLES|UNLOCK\s+TABLES|ANALYZE|OPTIMIZE|REPAIR|INSTALL|UNINSTALL)\b/i;

/** The offending keyword, or null when the statement is safe to run and undo. */
export function findImplicitCommit(sql: string): string | null {
  const stripped = stripLeadingComments(sql);
  const match = IMPLICIT_COMMIT.exec(stripped);
  return match ? match[1]!.toUpperCase().replace(/\s+/g, ' ') : null;
}

function stripLeadingComments(sql: string): string {
  let text = sql;
  for (;;) {
    const before = text;
    text = text.replace(/^\s+/, '');
    text = text.replace(/^--[^\n]*\n?/, '');
    text = text.replace(/^#[^\n]*\n?/, '');
    text = text.replace(/^\/\*[\s\S]*?\*\//, '');
    if (text === before) {
      return text;
    }
  }
}

export class MysqlAdapter implements DatabaseAdapter {
  readonly engine = 'mysql' as const;
  /** The whole reason this file reads the way it does. */
  readonly supportsTransactionalDDL = false;

  private connection: Connection | undefined;
  private config: ConnectionConfig | undefined;
  private database = '';
  /** One connection, so everything is serialised onto it. */
  private queue: Promise<unknown> = Promise.resolve();

  async connect(config: ConnectionConfig): Promise<void> {
    const mysql = await import('mysql2/promise');
    this.config = config;

    this.connection = await mysql.createConnection({
      uri: config.connectionString,
      // Refused rather than allowed: a single string carrying several
      // statements is how a preview turns into an apply by accident.
      multipleStatements: false,
      connectAttributes: { program_name: config.applicationName },
      // Numbers larger than a JS integer come back as strings rather than
      // silently losing precision. Every count here is parsed explicitly.
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: false,
    });

    const [rows] = await this.connection.query('SELECT DATABASE() AS db');
    this.database = String((rows as Row[])[0]?.['db'] ?? '');

    // MySQL has no lock_timeout; innodb_lock_wait_timeout is the nearest thing
    // and is measured in whole seconds.
    const lockSeconds = Math.max(1, Math.round(config.lockTimeoutMs / 1000));
    await this.connection.query(`SET SESSION innodb_lock_wait_timeout = ${lockSeconds}`);
    await this.connection.query(
      `SET SESSION max_execution_time = ${Math.floor(config.statementTimeoutMs)}`,
    );
  }

  async dispose(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.end().catch(() => undefined);
  }

  /**
   * Runs `fn` inside a transaction that is always rolled back.
   *
   * Identical in shape to the Postgres version and stricter in what it accepts.
   * Transaction control is refused for the same reason it is there; DDL is
   * refused because MySQL would commit it and the rollback below would be a
   * lie told with a straight face.
   */
  async withRollback<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const connection = this.requireConnection();

      const tx: Transaction = {
        query: async (sql: string, params?: readonly unknown[]): Promise<QueryResult> => {
          const control = findTransactionControl(sql);
          if (control !== null) {
            throw new TransactionControlError(control);
          }

          const ddl = findImplicitCommit(sql);
          if (ddl !== null) {
            throw new NonTransactionalDdlError(ddl);
          }

          const [rows, fields] = await connection.query(sql, params ? [...params] : undefined);
          return normalise(rows, fields);
        },

        savepoint: async (name: string): Promise<void> => {
          await connection.query(`SAVEPOINT ${savepointName(name)}`);
        },

        rollbackTo: async (name: string): Promise<void> => {
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepointName(name)}`);
        },
      };

      await connection.query('START TRANSACTION');
      try {
        return await fn(tx);
      } finally {
        // In a finally, so a thrown statement is rolled back too.
        await connection.query('ROLLBACK').catch(() => undefined);
      }
    });
  }

  // ---- read-only probes ---------------------------------------------------

  async countRows(
    table: string,
    where?: string,
    params: readonly unknown[] = [],
  ): Promise<number> {
    const clause = where && where.trim().length > 0 ? ` WHERE ${where}` : '';
    const rows = await this.probe(
      `SELECT COUNT(*) AS n FROM ${quote(table)}${clause}`,
      params,
    );
    return toNumber(rows[0]?.['n']);
  }

  quoteIdentifier(name: string): string {
    return quote(name);
  }

  async countNonNull(table: string, column: string): Promise<number> {
    const rows = await this.probe(
      `SELECT COUNT(${quote(column)}) AS n FROM ${quote(table)}`,
    );
    return toNumber(rows[0]?.['n']);
  }

  async countViolating(table: string, predicate: string): Promise<number> {
    // A row where the predicate is unknown does not violate a CHECK — MySQL
    // accepts NULL the same way Postgres does — so the negation has to be
    // explicit about it rather than relying on NOT alone.
    const rows = await this.probe(
      `SELECT COUNT(*) AS n FROM ${quote(table)} WHERE NOT (${predicate})`,
    );
    return toNumber(rows[0]?.['n']);
  }

  async countOrphans(
    table: string,
    columns: readonly string[],
    referencedTable: string,
    referencedColumns: readonly string[],
  ): Promise<number> {
    const on = columns
      .map((column, index) => `c.${quote(column)} = p.${quote(referencedColumns[index]!)}`)
      .join(' AND ');
    // Rows whose key is entirely NULL are not orphans; a foreign key permits
    // them, and counting them would report a failure that will not happen.
    const notNull = columns.map((column) => `c.${quote(column)} IS NOT NULL`).join(' AND ');

    const rows = await this.probe(
      `SELECT COUNT(*) AS n
         FROM ${quote(table)} c
         LEFT JOIN ${quote(referencedTable)} p ON ${on}
        WHERE ${notNull} AND p.${quote(referencedColumns[0]!)} IS NULL`,
    );
    return toNumber(rows[0]?.['n']);
  }

  async countDuplicates(
    table: string,
    columns: readonly string[],
  ): Promise<{ groups: number; rows: number }> {
    const list = columns.map(quote).join(', ');
    const notNull = columns.map((column) => `${quote(column)} IS NOT NULL`).join(' AND ');

    const rows = await this.probe(
      `SELECT COUNT(*) AS groups_count, COALESCE(SUM(c), 0) AS rows_count
         FROM (
           SELECT COUNT(*) AS c
             FROM ${quote(table)}
            WHERE ${notNull}
            GROUP BY ${list}
           HAVING COUNT(*) > 1
         ) AS duplicated`,
    );

    return {
      groups: toNumber(rows[0]?.['groups_count']),
      rows: toNumber(rows[0]?.['rows_count']),
    };
  }

  /**
   * Rows that would fail to cast.
   *
   * MySQL has no equivalent of a Postgres cast that raises: by default it
   * truncates, coerces and warns. So this asks the opposite question — how many
   * rows come back different after a round trip through the new type — which
   * catches the case that actually loses data.
   */
  async countCastFailures(
    table: string,
    column: string,
    newType: string,
  ): Promise<number | null> {
    const target = castTarget(newType);
    if (!target) {
      return null;
    }

    try {
      const rows = await this.probe(
        `SELECT COUNT(*) AS n
           FROM ${quote(table)}
          WHERE ${quote(column)} IS NOT NULL
            AND CAST(${quote(column)} AS ${target}) <=> ${quote(column)} = 0`,
      );
      return toNumber(rows[0]?.['n']);
    } catch {
      // Unverifiable is reported as unverifiable, never as zero.
      return null;
    }
  }

  async tableStats(table: string): Promise<TableStats> {
    const { schema, name } = split(table, this.database);
    const rows = await this.probe(
      `SELECT TABLE_ROWS AS estimated_rows,
              COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS total_bytes
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name],
    );

    if (rows.length === 0) {
      throw new Error(`No such table: ${table}`);
    }

    // TABLE_ROWS is an InnoDB estimate and can be wildly wrong on a small
    // table — often zero. Below the point where an estimate is useful, count.
    let estimated = toNumber(rows[0]?.['estimated_rows']);
    if (estimated < 1000) {
      estimated = await this.countRows(table);
    }

    return {
      schema,
      table: name,
      estimatedRows: estimated,
      totalBytes: toNumber(rows[0]?.['total_bytes']),
    };
  }

  async sampleRows(table: string, pks: PrimaryKeyValue[], limit: number): Promise<Row[]> {
    if (pks.length === 0) {
      return [];
    }
    const keys = Object.keys(pks[0] ?? {});
    if (keys.length === 0) {
      return [];
    }

    const wanted = pks.slice(0, limit);
    const predicate = wanted
      .map(() => `(${keys.map((key) => `${quote(key)} = ?`).join(' AND ')})`)
      .join(' OR ');
    const params = wanted.flatMap((pk) => keys.map((key) => pk[key]));

    return this.probe(
      `SELECT * FROM ${quote(table)} WHERE ${predicate} LIMIT ${Math.floor(limit)}`,
      params,
    );
  }

  async primaryKeyColumns(table: string): Promise<string[]> {
    const { schema, name } = split(table, this.database);
    const rows = await this.probe(
      `SELECT COLUMN_NAME AS name
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`,
      [schema, name],
    );
    return rows.map((row) => String(row['name']));
  }

  async tableColumns(table: string): Promise<ColumnInfo[]> {
    const { schema, name } = split(table, this.database);
    const rows = await this.probe(
      `SELECT COLUMN_NAME AS name,
              COLUMN_TYPE AS type,
              IS_NULLABLE = 'YES' AS nullable,
              COLUMN_KEY = 'PRI' AS is_primary,
              COLUMN_DEFAULT AS default_expression,
              EXTRA AS extra
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [schema, name],
    );

    return rows.map(toColumn);
  }

  async foreignKeys(tables: readonly string[]): Promise<ForeignKeyInfo[]> {
    if (tables.length === 0) {
      return [];
    }

    const names = tables.map((table) => split(table, this.database).name);
    const placeholders = names.map(() => '?').join(', ');

    const rows = await this.probe(
      `SELECT k.CONSTRAINT_NAME AS name,
              k.TABLE_NAME AS from_table,
              k.COLUMN_NAME AS from_column,
              k.REFERENCED_TABLE_NAME AS to_table,
              k.REFERENCED_COLUMN_NAME AS to_column
         FROM information_schema.KEY_COLUMN_USAGE k
        WHERE k.TABLE_SCHEMA = ?
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
          AND (k.TABLE_NAME IN (${placeholders}) OR k.REFERENCED_TABLE_NAME IN (${placeholders}))
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [this.database, ...names, ...names],
    );

    return groupKeys(rows);
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const tableRows = await this.probe(
      `SELECT TABLE_SCHEMA AS \`schema\`,
              TABLE_NAME AS name,
              COALESCE(TABLE_ROWS, 0) AS \`rows\`,
              COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [this.database],
    );

    const columnRows = await this.probe(
      `SELECT TABLE_NAME AS \`table\`,
              COLUMN_NAME AS name,
              COLUMN_TYPE AS type,
              IS_NULLABLE = 'YES' AS nullable,
              COLUMN_KEY = 'PRI' AS is_primary,
              COLUMN_DEFAULT AS default_expression,
              EXTRA AS extra
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [this.database],
    );

    const keyRows = await this.probe(
      `SELECT CONSTRAINT_NAME AS name,
              TABLE_NAME AS from_table,
              COLUMN_NAME AS from_column,
              REFERENCED_TABLE_NAME AS to_table,
              REFERENCED_COLUMN_NAME AS to_column
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [this.database],
    );

    const columnsByTable = new Map<string, ColumnInfo[]>();
    for (const row of columnRows) {
      const key = String(row['table']);
      const list = columnsByTable.get(key) ?? [];
      list.push(toColumn(row));
      columnsByTable.set(key, list);
    }

    const tables: SchemaTable[] = tableRows.map((row) => {
      const name = String(row['name']);
      return {
        schema: String(row['schema']),
        name,
        // MySQL has one schema per connection, so nothing is ever qualified.
        // Qualifying everything would put the database name on every card.
        qualified: name,
        rows: toNumber(row['rows']),
        bytes: toNumber(row['bytes']),
        columns: columnsByTable.get(name) ?? [],
        partitioned: false,
      };
    });

    return { tables, foreignKeys: groupKeys(keyRows), schemas: [this.database] };
  }

  async tableDetail(table: string, sampleLimit: number, filter?: string): Promise<TableDetail> {
    const { schema, name } = split(table, this.database);
    const columns = await this.tableColumns(table);
    if (columns.length === 0) {
      throw new Error(`No such table: ${table}`);
    }

    const indexRows = await this.probe(
      `SELECT INDEX_NAME AS name,
              COLUMN_NAME AS column_name,
              NON_UNIQUE = 0 AS is_unique,
              INDEX_NAME = 'PRIMARY' AS is_primary
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema, name],
    );

    const indexes = groupIndexes(indexRows, name);

    const constraintRows = await this.probe(
      `SELECT CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type
         FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY CONSTRAINT_NAME`,
      [schema, name],
    );

    const constraints: ConstraintInfo[] = constraintRows.map((row) => ({
      name: String(row['name']),
      type: constraintType(String(row['type'])),
      definition: `${String(row['type'])} (${String(row['name'])})`,
    }));

    const searching = Boolean(filter && filter.trim().length > 0);
    const where = searching ? textFilter(columns) : '';
    const sample =
      sampleLimit > 0
        ? await this.probe(
            `SELECT * FROM ${quote(table)}${where ? ` WHERE ${where}` : ''} ` +
              `LIMIT ${Math.floor(sampleLimit)}`,
            searching ? columns.map(() => `%${filter!.toLowerCase()}%`) : [],
          )
        : [];

    const stats = await this.tableStats(table);

    return {
      table,
      columns,
      indexes,
      constraints,
      primaryKey: columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
      rows: stats.estimatedRows,
      rowsEstimated: stats.estimatedRows >= 1000,
      sample,
      ...(filter ? { filter, matched: sample.length } : {}),
    };
  }

  async rowsMatching(
    table: string,
    where: string,
    limit: number,
    orderBy?: string,
  ): Promise<Row[]> {
    const order = orderBy && orderBy.trim().length > 0 ? ` ORDER BY ${orderBy}` : '';
    return this.probe(
      `SELECT * FROM ${quote(table)} WHERE ${where}${order} LIMIT ${Math.floor(limit)}`,
    );
  }

  /**
   * Sessions holding a lock on `table` right now.
   *
   * MySQL exposes far less than Postgres here: performance_schema knows which
   * threads hold metadata locks, but not always on what, and the view is
   * optional. An empty answer therefore means "nothing found", never "nothing
   * there", and callers already treat it that way.
   */
  async lockHolders(table: string): Promise<LockHolder[]> {
    const { schema, name } = split(table, this.database);

    try {
      const rows = await this.probe(
        `SELECT p.ID AS pid,
                COALESCE(p.COMMAND, '') AS state,
                COALESCE(p.USER, '') AS application_name,
                COALESCE(p.INFO, '') AS query,
                COALESCE(p.TIME, 0) AS seconds,
                COALESCE(m.LOCK_TYPE, 'metadata') AS lock_mode
           FROM performance_schema.metadata_locks m
           JOIN performance_schema.threads t ON t.THREAD_ID = m.OWNER_THREAD_ID
           JOIN information_schema.PROCESSLIST p ON p.ID = t.PROCESSLIST_ID
          WHERE m.OBJECT_SCHEMA = ? AND m.OBJECT_NAME = ?
            AND m.LOCK_STATUS = 'GRANTED'
            AND p.ID <> CONNECTION_ID()
          ORDER BY seconds DESC`,
        [schema, name],
      );

      return rows.map((row) => ({
        pid: toNumber(row['pid']),
        state: String(row['state']),
        applicationName: String(row['application_name']),
        query: String(row['query']).replace(/\s+/g, ' ').slice(0, 200),
        seconds: toNumber(row['seconds']),
        lockMode: String(row['lock_mode']),
      }));
    } catch {
      // performance_schema can be compiled out or denied. Saying nothing is
      // the honest answer; claiming the table is free would not be.
      return [];
    }
  }

  /**
   * Rows a delete would cascade to.
   *
   * Same bounded walk as the Postgres adapter, over MySQL's own idea of a
   * referential action.
   */
  async cascadeImpact(
    table: string,
    where: string,
    params: readonly unknown[],
  ): Promise<CascadeNode> {
    const MAX_DEPTH = 4;
    const MAX_TABLES = 25;
    let visited = 0;

    const walk = async (
      current: string,
      predicate: string,
      depth: number,
      seen: ReadonlySet<string>,
    ): Promise<CascadeNode> => {
      const rows = await this.countRows(current, predicate, depth === 0 ? params : []);

      if (depth >= MAX_DEPTH || visited >= MAX_TABLES) {
        return { table: current, rows, children: [], truncated: 'Stopped walking here.' };
      }

      const children: CascadeNode[] = [];
      const referring = await this.probe(
        `SELECT k.TABLE_NAME AS child,
                k.COLUMN_NAME AS child_column,
                k.REFERENCED_COLUMN_NAME AS parent_column,
                k.CONSTRAINT_NAME AS name,
                r.DELETE_RULE AS action
           FROM information_schema.KEY_COLUMN_USAGE k
           JOIN information_schema.REFERENTIAL_CONSTRAINTS r
             ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
          WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?
            AND r.DELETE_RULE IN ('CASCADE', 'SET NULL')`,
        [this.database, split(current, this.database).name],
      );

      for (const row of referring) {
        const child = String(row['child']);
        if (seen.has(child)) {
          continue;
        }
        visited += 1;
        if (visited > MAX_TABLES) {
          break;
        }

        const childPredicate =
          `${quote(String(row['child_column']))} IN ` +
          `(SELECT ${quote(String(row['parent_column']))} FROM ${quote(current)} ` +
          `WHERE ${predicate})`;

        const node = await walk(child, childPredicate, depth + 1, new Set([...seen, child]));
        children.push({
          ...node,
          via: {
            constraint: String(row['name']),
            action: String(row['action']) === 'CASCADE' ? 'cascade' : 'set null',
          },
        });
      }

      return { table: current, rows, children };
    };

    return walk(table, where, 0, new Set([table]));
  }

  async triggers(table: string): Promise<TriggerInfo[]> {
    const { schema, name } = split(table, this.database);
    const rows = await this.probe(
      `SELECT TRIGGER_NAME AS name,
              ACTION_TIMING AS timing,
              EVENT_MANIPULATION AS event,
              COALESCE(ACTION_STATEMENT, '') AS body
         FROM information_schema.TRIGGERS
        WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
        ORDER BY TRIGGER_NAME`,
      [schema, name],
    );

    return rows.map((row) => ({
      name: String(row['name']),
      table,
      timing: String(row['timing']).toLowerCase() === 'before' ? 'before' : 'after',
      events: [String(row['event']).toLowerCase()],
      // MySQL triggers carry their body rather than calling a named function.
      functionName: String(row['name']),
      // MySQL has no way to disable a trigger short of dropping it.
      enabled: true,
      escapes: escapesRollback(String(row['body'])),
    }));
  }

  async schemaHealth(): Promise<SchemaHealth> {
    const unusedIndexes = await this.unusedIndexes();
    const redundantIndexes = await this.redundantIndexes();
    const unindexedForeignKeys = await this.unindexedForeignKeys();
    const tables = await this.tableHealth();

    return {
      // MySQL's index statistics come from performance_schema, which is reset
      // when the server restarts and has no timestamp of its own. The server's
      // start time is the honest window.
      statsSince: await this.startedAt(),
      unusedIndexes,
      redundantIndexes,
      unindexedForeignKeys,
      tables,
    };
  }

  async supportsHypotheticalIndexes(): Promise<boolean> {
    // No MySQL equivalent of hypopg exists. Saying so plainly is better than
    // an approximation nobody asked for.
    return false;
  }

  async testIndex(
    _indexSql: string,
    _query: string,
    _params: readonly unknown[],
    options: { readonly build: boolean },
  ): Promise<IndexExperiment> {
    if (!options.build) {
      throw new HypotheticalIndexUnavailableError();
    }
    // Building it for real is the fallback on Postgres because the transaction
    // takes it away again. Here it would not: CREATE INDEX commits itself, and
    // this would leave an index behind on someone's database.
    throw new NonTransactionalDdlError('CREATE INDEX');
  }

  async runCommitted(): Promise<{ applied: number; rowCounts: readonly (number | null)[] }> {
    throw new NonTransactionalDdlError(
      'applying a changeset',
    );
  }

  async explain(
    sql: string,
    analyze: boolean,
    params: readonly unknown[] = [],
  ): Promise<QueryPlan> {
    if (analyze) {
      throw new Error(
        'EXPLAIN ANALYZE executes the statement for real. Run it through withRollback instead.',
      );
    }
    const rows = await this.probe(`EXPLAIN FORMAT=JSON ${sql}`, params);
    const raw = rows[0]?.['EXPLAIN'];
    return { raw: typeof raw === 'string' ? JSON.parse(raw) : raw };
  }

  // ---- internals ----------------------------------------------------------

  private async startedAt(): Promise<Date | null> {
    try {
      const rows = await this.probe(
        `SELECT NOW() - INTERVAL VARIABLE_VALUE SECOND AS started
           FROM performance_schema.global_status
          WHERE VARIABLE_NAME = 'Uptime'`,
      );
      const started = rows[0]?.['started'];
      return started instanceof Date ? started : started ? new Date(String(started)) : null;
    } catch {
      return null;
    }
  }

  private async unusedIndexes(): Promise<SchemaHealth['unusedIndexes']> {
    try {
      const rows = await this.probe(
        `SELECT t.OBJECT_NAME AS table_name,
                t.INDEX_NAME AS index_name,
                t.COUNT_STAR AS scans,
                COALESCE(s.STAT_VALUE * @@innodb_page_size, 0) AS bytes
           FROM performance_schema.table_io_waits_summary_by_index_usage t
           LEFT JOIN mysql.innodb_index_stats s
             ON s.database_name = t.OBJECT_SCHEMA
            AND s.table_name = t.OBJECT_NAME
            AND s.index_name = t.INDEX_NAME
            AND s.stat_name = 'size'
          WHERE t.OBJECT_SCHEMA = ?
            AND t.INDEX_NAME IS NOT NULL
            AND t.INDEX_NAME <> 'PRIMARY'
            AND t.COUNT_STAR = 0
            AND NOT EXISTS (
              SELECT 1 FROM information_schema.STATISTICS i
               WHERE i.TABLE_SCHEMA = t.OBJECT_SCHEMA
                 AND i.TABLE_NAME = t.OBJECT_NAME
                 AND i.INDEX_NAME = t.INDEX_NAME
                 AND i.NON_UNIQUE = 0
            )
          GROUP BY table_name, index_name, scans, bytes
          ORDER BY bytes DESC`,
        [this.database],
      );

      return rows.map((row) => ({
        table: String(row['table_name']),
        index: String(row['index_name']),
        scans: toNumber(row['scans']),
        bytes: toNumber(row['bytes']),
        definition: `INDEX ${String(row['index_name'])} ON ${String(row['table_name'])}`,
      }));
    } catch {
      return [];
    }
  }

  private async redundantIndexes(): Promise<SchemaHealth['redundantIndexes']> {
    const rows = await this.probe(
      `SELECT TABLE_NAME AS table_name,
              INDEX_NAME AS index_name,
              NON_UNIQUE = 0 AS is_unique,
              GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
      [this.database],
    );

    const byTable = new Map<string, { name: string; columns: string; unique: boolean }[]>();
    for (const row of rows) {
      const table = String(row['table_name']);
      const list = byTable.get(table) ?? [];
      list.push({
        name: String(row['index_name']),
        columns: String(row['columns'] ?? ''),
        unique: Boolean(toNumber(row['is_unique'])),
      });
      byTable.set(table, list);
    }

    const redundant: SchemaHealth['redundantIndexes'][number][] = [];
    for (const [table, indexes] of byTable) {
      for (const short of indexes) {
        if (short.name === 'PRIMARY' || short.unique) {
          continue;
        }
        const covering = indexes.find(
          (long) =>
            long.name !== short.name &&
            long.columns.length > short.columns.length &&
            long.columns.startsWith(`${short.columns},`),
        );
        if (covering) {
          redundant.push({ table, index: short.name, coveredBy: covering.name, bytes: 0 });
        }
      }
    }
    return redundant;
  }

  private async unindexedForeignKeys(): Promise<SchemaHealth['unindexedForeignKeys']> {
    // InnoDB creates an index for every foreign key it does not already have
    // one for, so this is nearly always empty — and saying that plainly is
    // more useful than an empty section people read as a bug.
    const rows = await this.probe(
      `SELECT k.CONSTRAINT_NAME AS name,
              k.TABLE_NAME AS table_name,
              k.REFERENCED_TABLE_NAME AS referenced_table,
              GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS columns,
              COALESCE(t.TABLE_ROWS, 0) AS rows_estimate
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.TABLES t
           ON t.TABLE_SCHEMA = k.TABLE_SCHEMA AND t.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ?
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.STATISTICS s
             WHERE s.TABLE_SCHEMA = k.TABLE_SCHEMA
               AND s.TABLE_NAME = k.TABLE_NAME
               AND s.COLUMN_NAME = k.COLUMN_NAME
               AND s.SEQ_IN_INDEX = 1
          )
        GROUP BY name, table_name, referenced_table, rows_estimate`,
      [this.database],
    );

    return rows.map((row) => ({
      constraint: String(row['name']),
      table: String(row['table_name']),
      referencedTable: String(row['referenced_table']),
      columns: String(row['columns'] ?? '').split(','),
      rows: toNumber(row['rows_estimate']),
    }));
  }

  private async tableHealth(): Promise<SchemaHealth['tables']> {
    const rows = await this.probe(
      `SELECT TABLE_NAME AS table_name,
              COALESCE(TABLE_ROWS, 0) AS live_rows,
              COALESCE(DATA_FREE, 0) AS dead_bytes,
              COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes,
              UPDATE_TIME AS updated
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY bytes DESC`,
      [this.database],
    );

    return rows.map((row) => {
      const bytes = toNumber(row['bytes']);
      const free = toNumber(row['dead_bytes']);
      const live = toNumber(row['live_rows']);

      return {
        table: String(row['table_name']),
        liveRows: live,
        // MySQL counts reclaimable space, not dead rows. Converted at the
        // table's own average row size so the number means the same thing the
        // Postgres one does.
        deadRows: bytes > 0 && live > 0 ? Math.round((free / bytes) * live) : 0,
        // No equivalent of n_mod_since_analyze exists.
        modifiedSinceAnalyze: 0,
        lastVacuum: null,
        lastAnalyze: row['updated'] instanceof Date ? (row['updated'] as Date) : null,
        bytes,
      };
    });
  }

  private async probe(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.serialize(async () => {
      const [rows] = await this.requireConnection().query(sql, [...params]);
      return Array.isArray(rows) ? (rows as Row[]) : [];
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    // Keeps the chain alive when `run` rejects, so one failure does not poison
    // every call after it.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw new Error('Not connected.');
    }
    return this.connection;
  }
}

// ---- helpers ---------------------------------------------------------------

function toColumn(row: Row): ColumnInfo {
  const extra = String(row['extra'] ?? '');
  const fallback = row['default_expression'];

  return {
    name: String(row['name']),
    type: String(row['type']),
    nullable: Boolean(toNumber(row['nullable'])),
    isPrimaryKey: Boolean(toNumber(row['is_primary'])),
    ...(fallback === null || fallback === undefined
      ? {}
      : { defaultExpression: String(fallback) }),
    // MySQL's answer to a sequence. Reported as identity so a rebuild puts it
    // back rather than producing a column that has stopped generating.
    ...(/auto_increment/i.test(extra) ? { identity: 'by default' as const } : {}),
  };
}

function groupKeys(rows: readonly Row[]): ForeignKeyInfo[] {
  const byName = new Map<string, ForeignKeyInfo & { fromColumns: string[]; toColumns: string[] }>();

  for (const row of rows) {
    const name = String(row['name']);
    const existing = byName.get(name);
    if (existing) {
      existing.fromColumns.push(String(row['from_column']));
      existing.toColumns.push(String(row['to_column']));
      continue;
    }
    byName.set(name, {
      name,
      fromTable: String(row['from_table']),
      fromColumns: [String(row['from_column'])],
      toTable: String(row['to_table']),
      toColumns: [String(row['to_column'])],
    });
  }

  return [...byName.values()];
}

function groupIndexes(rows: readonly Row[], table: string): IndexInfo[] {
  const byName = new Map<string, { columns: string[]; unique: boolean; primary: boolean }>();

  for (const row of rows) {
    const name = String(row['name']);
    const entry = byName.get(name) ?? {
      columns: [],
      unique: Boolean(toNumber(row['is_unique'])),
      primary: Boolean(toNumber(row['is_primary'])),
    };
    entry.columns.push(String(row['column_name']));
    byName.set(name, entry);
  }

  return [...byName.entries()].map(([name, entry]) => ({
    name,
    columns: entry.columns,
    unique: entry.unique,
    primary: entry.primary,
    definition:
      `CREATE ${entry.unique ? 'UNIQUE ' : ''}INDEX ${quote(name)} ` +
      `ON ${quote(table)} (${entry.columns.map(quote).join(', ')})`,
  }));
}

function constraintType(type: string): ConstraintInfo['type'] {
  switch (type.toUpperCase()) {
    case 'PRIMARY KEY':
      return 'primary key';
    case 'FOREIGN KEY':
      return 'foreign key';
    case 'UNIQUE':
      return 'unique';
    case 'CHECK':
      return 'check';
    default:
      return 'other';
  }
}

/**
 * A LIKE across every column, for finding one row among many.
 *
 * One placeholder per column rather than one for the whole clause: MySQL binds
 * positionally and has no named parameters, so the same value has to be passed
 * once for each place it appears.
 */
function textFilter(columns: readonly ColumnInfo[]): string {
  return columns
    .map((column) => `LOWER(CONVERT(${quote(column.name)} USING utf8mb4)) LIKE ?`)
    .join(' OR ');
}

/**
 * The MySQL type a CAST can actually target.
 *
 * CAST accepts a much shorter list than a column definition does, and asking
 * for one it does not know is an error rather than a failed cast.
 */
function castTarget(newType: string): string | null {
  const type = newType.trim().toLowerCase();
  if (/^(char|varchar|text|tinytext|mediumtext|longtext)/.test(type)) {
    const size = /\((\d+)\)/.exec(type)?.[1];
    return size ? `CHAR(${size})` : 'CHAR';
  }
  if (/^(int|integer|smallint|mediumint|bigint|tinyint)/.test(type)) {
    return 'SIGNED';
  }
  if (/^(decimal|numeric)/.test(type)) {
    const args = /\(([^)]+)\)/.exec(type)?.[1];
    return args ? `DECIMAL(${args})` : 'DECIMAL';
  }
  if (/^(date)$/.test(type)) {
    return 'DATE';
  }
  if (/^(datetime|timestamp)/.test(type)) {
    return 'DATETIME';
  }
  if (/^(float|double|real)/.test(type)) {
    // No CAST target for these, and pretending otherwise would report zero
    // failures for a conversion that can absolutely lose precision.
    return null;
  }
  return null;
}

/** Things in a trigger body that a rollback does not take back. */
function escapesRollback(body: string): string[] {
  const found: string[] = [];
  const check = (pattern: RegExp, description: string): void => {
    if (pattern.test(body)) {
      found.push(description);
    }
  };

  check(/\bsys_exec\s*\(|\bsys_eval\s*\(/i, 'runs a shell command (sys_exec / sys_eval)');
  check(/\blib_mysqludf_sys/i, 'calls a system UDF');
  check(/\bhttp_(get|post)\s*\(/i, 'makes an HTTP request');
  check(/\bSELECT\b[\s\S]{0,120}\bINTO\s+(OUT|DUMP)FILE\b/i, 'writes a file on the server');

  return found;
}

function split(table: string, fallback: string): { schema: string; name: string } {
  const parts = table.replace(/`/g, '').split('.');
  return parts.length > 1
    ? { schema: parts[0]!, name: parts.slice(1).join('.') }
    : { schema: fallback, name: parts[0]! };
}

/**
 * Quotes an identifier with backticks.
 *
 * Identifiers cannot be bound as parameters, so this is the one place where
 * caller-supplied text reaches the SQL directly. Anything it cannot quote
 * safely is refused rather than cleaned up: a table name containing a backtick
 * or a null byte is not a typo.
 */
export function quote(identifier: string): string {
  return identifier
    .replace(/`/g, '')
    .split('.')
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed.length === 0 || trimmed.includes('\0')) {
        throw new Error(`Invalid identifier: ${JSON.stringify(identifier)}`);
      }
      return `\`${trimmed}\``;
    })
    .join('.');
}

function savepointName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid savepoint name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Counts arrive as strings when they might not fit a JS integer. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalise(rows: unknown, fields: unknown): QueryResult {
  if (Array.isArray(rows)) {
    return { rows: rows as Row[], rowCount: rows.length };
  }
  // An INSERT, UPDATE or DELETE returns a header rather than rows.
  const header = rows as { affectedRows?: number } | undefined;
  void fields;
  return { rows: [], rowCount: header?.affectedRows ?? null };
}
