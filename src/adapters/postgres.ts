import { Client } from 'pg';
import {
  ColumnInfo,
  ConstraintInfo,
  ConnectionConfig,
  DatabaseAdapter,
  CascadeAction,
  CascadeNode,
  ForeignKeyInfo,
  LockHolder,
  PrimaryKeyValue,
  QueryPlan,
  QueryResult,
  Row,
  SchemaSnapshot,
  SchemaTable,
  TableDetail,
  TableStats,
  Transaction,
  TransactionControlError,
  IndexExperiment,
  HypotheticalIndexUnavailableError,
  SchemaHealth,
  UnusedIndex,
  RedundantIndex,
  UnindexedForeignKey,
  TableHealth,
  TriggerInfo,
} from './types';
import { executionMs, indexNames, totalCost } from './planShape';
import { CommittableStatement, CommittedResult, runCommittedOn } from './commit';
import { findTransactionControl } from '../parser/transactionControl';
import { describeError } from '../errors';

/**
 * Postgres adapter.
 *
 * Postgres is the v1 target because its DDL is transactional, which makes a
 * genuine execute-then-discard preview possible rather than an estimate.
 *
 * One connection per adapter, deliberately (spec §10.8). Every call is
 * serialized through a queue so overlapping analyses can never interleave
 * statements inside one another's transaction.
 */
const CAST_SAVEPOINT = 'dryrun_cast';

export class PostgresAdapter implements DatabaseAdapter {
  readonly engine = 'postgres' as const;
  readonly supportsTransactionalDDL = true;

  private client: Client | null = null;
  /** Set when the socket has died and the client can never be used again. */
  private broken = false;
  private config: ConnectionConfig | null = null;
  /** Tail of the serialization queue. */
  private queue: Promise<unknown> = Promise.resolve();

  async connect(config: ConnectionConfig): Promise<void> {
    if (this.client) {
      throw new Error('Already connected. Dispose the adapter before reconnecting.');
    }
    await this.open(config);
  }

  /** Opens the socket. Separate from `connect` so reconnecting can reuse it. */
  private async open(config: ConnectionConfig): Promise<void> {

    const client = new Client({
      connectionString: config.connectionString,
      application_name: config.applicationName,
      // Client-side ceiling, so a hung server cannot hang the extension host.
      query_timeout: config.statementTimeoutMs + 1000,
      connectionTimeoutMillis: 10_000,
    });

    // A client that has errored is unusable for ever afterwards, and `pg`
    // reports that by emitting on the client rather than by rejecting the next
    // query. Without a listener the process would also take an unhandled
    // 'error' event, which in an extension host is worse than a dead socket.
    client.on('error', () => {
      this.broken = true;
    });

    await client.connect();
    this.client = client;
    this.config = config;
    this.broken = false;

    // Session-level ceilings, so read-only probes running outside a
    // transaction are bounded too.
    await client.query(`SET statement_timeout = ${Math.floor(config.statementTimeoutMs)}`);
    await client.query(`SET lock_timeout = ${Math.floor(config.lockTimeoutMs)}`);
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.config = null;
    if (client) {
      await client.end().catch(() => {
        /* the socket is going away regardless */
      });
    }
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Runs `fn` inside a transaction that is always rolled back.
   *
   * The rollback is in `finally`, so it happens when `fn` returns, when `fn`
   * throws, and when a statement inside `fn` times out. There is no code path
   * in this class that issues a COMMIT.
   */
  async withRollback<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    // Safe to retry in full. Nothing inside a preview can commit — that is
    // enforced by `query` refusing transaction control, and it is the property
    // the whole extension is built on — so a socket that dies mid-preview
    // means the server has already thrown the transaction away. Running it
    // again on a new connection repeats work, not effects.
    return this.serialize(() => this.withReconnect(() => this.runRolledBack(fn)));
  }

  private async runRolledBack<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      const client = this.requireClient();
      const config = this.config!;

      const tx: Transaction = {
        query: async (sql: string, params?: readonly unknown[]): Promise<QueryResult> => {
          const offender = findTransactionControl(sql);
          if (offender !== null) {
            throw new TransactionControlError(offender);
          }
          const result = await client.query(sql, params ? [...params] : undefined);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },

        savepoint: async (name: string): Promise<void> => {
          await client.query(`SAVEPOINT ${savepointName(name)}`);
        },

        rollbackTo: async (name: string): Promise<void> => {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName(name)}`);
        },
      };

      await client.query('BEGIN');
      try {
        await client.query(
          `SET LOCAL statement_timeout = ${Math.floor(config.statementTimeoutMs)}`,
        );
        await client.query(`SET LOCAL lock_timeout = ${Math.floor(config.lockTimeoutMs)}`);
        return await fn(tx);
      } finally {
        // Unconditional. If this throws, the connection is already unusable,
        // in which case the transaction is dead and nothing was persisted.
        await client.query('ROLLBACK').catch(() => {
          /* connection lost: the server discards the transaction for us */
        });
      }
  }

  /**
   * Applies previously-previewed statements for real.
   *
   * The only write path in the adapter. It delegates to `commit.ts`, which is
   * the sole file exempt from the no-commit rule, so that this capability lives
   * somewhere it can be read in one sitting rather than being spread out.
   */
  /**
   * The one thing that is never retried.
   *
   * Everything else here reconnects and runs again, because everything else
   * either reads or rolls back. This commits. A socket that dies while a
   * COMMIT is in flight leaves the outcome genuinely unknown — the server may
   * have applied it and lost the acknowledgement — and running it a second
   * time could apply it twice.
   *
   * So it fails, and says which of the two it is: never started, or unknown.
   * Guessing on the user's behalf is the one thing that would be worse than
   * either.
   */
  async runCommitted(statements: readonly CommittableStatement[]): Promise<CommittedResult> {
    return this.serialize(async () => {
      const config = this.config!;

      if (this.broken) {
        await this.reconnect();
      }

      try {
        return await runCommittedOn(
          this.requireClient(),
          {
            statementTimeoutMs: config.statementTimeoutMs,
            lockTimeoutMs: config.lockTimeoutMs,
          },
          statements,
        );
      } catch (error) {
        if (isConnectionDead(error)) {
          this.broken = true;
          throw new UncertainApplyError(describeError(error));
        }
        throw error;
      }
    });
  }

  // ---- read-only probes -------------------------------------------------

  async countRows(table: string, where?: string, params: readonly unknown[] = []): Promise<number> {
    const clause = where && where.trim().length > 0 ? ` WHERE ${where}` : '';
    const { rows } = await this.probe(
      `SELECT COUNT(*)::bigint AS n FROM ${qualify(table)}${clause}`,
      params,
    );
    return readCount(rows);
  }

  async countNonNull(table: string, column: string): Promise<number> {
    const { rows } = await this.probe(
      `SELECT COUNT(*)::bigint AS n FROM ${qualify(table)} WHERE ${quoteIdent(column)} IS NOT NULL`,
    );
    return readCount(rows);
  }

  /**
   * Counts rows that definitely violate `predicate`, using CHECK-constraint
   * semantics: a row passes when the predicate is TRUE *or* NULL, so only
   * `NOT (predicate)` evaluating to TRUE counts as a violation.
   */
  async countViolating(table: string, predicate: string): Promise<number> {
    const { rows } = await this.probe(
      `SELECT COUNT(*)::bigint AS n FROM ${qualify(table)} WHERE NOT (${predicate})`,
    );
    return readCount(rows);
  }

  async countOrphans(
    table: string,
    columns: readonly string[],
    referencedTable: string,
    referencedColumns: readonly string[],
  ): Promise<number> {
    const refColumns = referencedColumns.length > 0 ? referencedColumns : columns;
    if (columns.length === 0 || columns.length !== refColumns.length) {
      throw new Error('Foreign key columns do not line up with the referenced columns.');
    }

    const on = columns
      .map((c, i) => `r.${quoteIdent(refColumns[i]!)} = t.${quoteIdent(c)}`)
      .join(' AND ');
    // A NULL in any part of the key satisfies a foreign key by definition, so
    // those rows are excluded rather than counted as orphans.
    const notNull = columns.map((c) => `t.${quoteIdent(c)} IS NOT NULL`).join(' AND ');

    const { rows } = await this.probe(
      `SELECT COUNT(*)::bigint AS n
         FROM ${qualify(table)} t
         LEFT JOIN ${qualify(referencedTable)} r ON ${on}
        WHERE ${notNull} AND r.${quoteIdent(refColumns[0]!)} IS NULL`,
    );
    return readCount(rows);
  }

  async countDuplicates(
    table: string,
    columns: readonly string[],
  ): Promise<{ groups: number; rows: number }> {
    if (columns.length === 0) {
      return { groups: 0, rows: 0 };
    }

    const list = columns.map(quoteIdent).join(', ');
    // NULLs never collide under a unique constraint, so they are excluded.
    const notNull = columns.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(' AND ');

    const { rows } = await this.probe(
      `SELECT COUNT(*)::bigint AS groups, COALESCE(SUM(c), 0)::bigint AS rows
         FROM (
           SELECT COUNT(*) AS c
             FROM ${qualify(table)}
            WHERE ${notNull}
            GROUP BY ${list}
           HAVING COUNT(*) > 1
         ) d`,
    );

    const row = rows[0];
    return {
      groups: Number(row?.['groups'] ?? 0),
      rows: Number(row?.['rows'] ?? 0),
    };
  }

  async countCastFailures(table: string, column: string, newType: string): Promise<number | null> {
    // A failing cast raises, which would abort whatever transaction it runs in.
    // It runs inside its own rolled-back transaction with a savepoint so that
    // a raise costs nothing, and an unsupported cast is reported as unknown
    // rather than silently as zero.
    return this.withRollback(async (tx) => {
      await tx.savepoint(CAST_SAVEPOINT);
      try {
        const { rows } = await tx.query(
          `SELECT COUNT(*)::bigint AS n
             FROM ${qualify(table)}
            WHERE ${quoteIdent(column)} IS NOT NULL
              AND CAST(${quoteIdent(column)} AS ${newType}) IS NULL`,
        );
        return readCount(rows);
      } catch {
        await tx.rollbackTo(CAST_SAVEPOINT).catch(() => undefined);
        return null;
      }
    });
  }

  async tableStats(table: string): Promise<TableStats> {
    const { rows } = await this.probe(
      `SELECT n.nspname AS schema,
              c.relname AS name,
              c.reltuples::bigint AS estimated_rows,
              pg_total_relation_size(c.oid)::bigint AS total_bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass($1)`,
      [table],
    );

    const row = rows[0];
    if (!row) {
      throw new Error(`Table not found: ${table}`);
    }

    // Postgres reports reltuples = -1 for a table that has never been analysed,
    // which is different from 0 and must not be flattened into it: one means
    // "no idea", the other means "empty", and a table nobody has analysed is
    // exactly the freshly-loaded table most likely to be large. Clamping the
    // two together would silently size an index-build warning, or a blast
    // radius bar, against a row count of zero.
    const estimate = Number(row['estimated_rows']);
    const estimatedRows = estimate >= 0 ? estimate : await this.countRows(table);

    return {
      schema: String(row['schema']),
      table: String(row['name']),
      estimatedRows,
      totalBytes: Number(row['total_bytes']),
    };
  }

  async primaryKeyColumns(table: string): Promise<string[]> {
    const { rows } = await this.probe(
      `SELECT a.attname AS name
         FROM pg_index i
         JOIN pg_attribute a
           ON a.attrelid = i.indrelid
          AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1)
          AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)`,
      [table],
    );
    return rows.map((r) => String(r['name']));
  }

  async tableColumns(table: string): Promise<ColumnInfo[]> {
    const { rows } = await this.probe(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              -- Needed to reverse a DROP COLUMN: putting the column back
              -- without its default puts back a different column.
              pg_get_expr(d.adbin, d.adrelid) AS default_expression,
              -- 'a' for GENERATED ALWAYS, 'd' for BY DEFAULT, '' for neither.
              -- An identity column has no default expression, so without this
              -- it rebuilds as a plain integer and quietly stops generating.
              a.attidentity AS identity,
              EXISTS (
                SELECT 1 FROM pg_index i
                 WHERE i.indrelid = a.attrelid
                   AND i.indisprimary
                   AND a.attnum = ANY(i.indkey)
              ) AS is_primary
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass($1)
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [table],
    );

    return rows.map((row) => ({
      name: String(row['name']),
      type: String(row['type']),
      nullable: Boolean(row['nullable']),
      isPrimaryKey: Boolean(row['is_primary']),
      defaultExpression:
        row['default_expression'] === null || row['default_expression'] === undefined
          ? undefined
          : String(row['default_expression']),
      identity:
        row['identity'] === 'a' ? 'always' : row['identity'] === 'd' ? 'by default' : undefined,
    }));
  }

  async foreignKeys(tables: readonly string[]): Promise<ForeignKeyInfo[]> {
    if (tables.length === 0) {
      return [];
    }

    const { rows } = await this.probe(
      `SELECT c.conname AS name,
              src.relname AS from_table,
              tgt.relname AS to_table,
              (SELECT array_agg(att.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS from_columns,
              (SELECT array_agg(att.attname::text ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = c.confrelid AND att.attnum = k.attnum) AS to_columns
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
         JOIN pg_class tgt ON tgt.oid = c.confrelid
        WHERE c.contype = 'f'
          AND (src.relname = ANY($1) OR tgt.relname = ANY($1))`,
      [tables.map(bareName)],
    );

    return rows.map((row) => ({
      name: String(row['name']),
      fromTable: String(row['from_table']),
      fromColumns: (row['from_columns'] as string[] | null) ?? [],
      toTable: String(row['to_table']),
      toColumns: (row['to_columns'] as string[] | null) ?? [],
    }));
  }

  /**
   * The whole database in three queries.
   *
   * Three, not one per table: a schema with two hundred tables would otherwise
   * be six hundred round trips, and on a cloud database that is minutes rather
   * than the moment this needs to take.
   *
   * System schemas are excluded, along with TOAST and any extension-owned
   * table, because nobody wants to look at a diagram of `pg_catalog`.
   */
  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const tablesResult = await this.probe(
      `SELECT n.nspname AS schema,
              c.relname AS name,
              GREATEST(c.reltuples, 0)::bigint AS rows,
              pg_total_relation_size(c.oid)::bigint AS bytes,
              c.relkind = 'p' AS partitioned
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.objid = c.oid AND d.deptype = 'e'
          )
        ORDER BY n.nspname, c.relname`,
    );

    const columnsResult = await this.probe(
      `SELECT n.nspname AS schema,
              c.relname AS "table",
              a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              -- Carried here as well as in tableColumns, because comparing two
              -- databases reads snapshots, and a default that drifts between
              -- environments is exactly the kind of thing that only breaks in
              -- one of them.
              pg_get_expr(ad.adbin, ad.adrelid) AS default_expression,
              COALESCE(pk.is_primary, false) AS is_primary
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
         LEFT JOIN LATERAL (
           SELECT true AS is_primary
             FROM pg_index i
            WHERE i.indrelid = a.attrelid
              AND i.indisprimary
              AND a.attnum = ANY(i.indkey)
            LIMIT 1
         ) pk ON true
        WHERE c.relkind IN ('r', 'p')
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%'
        ORDER BY n.nspname, c.relname, a.attnum`,
    );

    const keysResult = await this.probe(
      `SELECT c.conname AS name,
              srcn.nspname AS from_schema,
              src.relname AS from_table,
              tgtn.nspname AS to_schema,
              tgt.relname AS to_table,
              (SELECT array_agg(att.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS from_columns,
              (SELECT array_agg(att.attname::text ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = c.confrelid AND att.attnum = k.attnum) AS to_columns
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
         JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
         JOIN pg_class tgt ON tgt.oid = c.confrelid
         JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
        WHERE c.contype = 'f'
          AND srcn.nspname NOT IN ('pg_catalog', 'information_schema')`,
    );

    // Columns are grouped onto their tables here rather than in a join, so the
    // wire carries one row per column instead of one per column per key.
    const columnsByTable = new Map<string, ColumnInfo[]>();
    for (const row of columnsResult.rows) {
      const key = `${String(row['schema'])}.${String(row['table'])}`;
      const list = columnsByTable.get(key) ?? [];
      list.push({
        name: String(row['name']),
        type: String(row['type']),
        nullable: Boolean(row['nullable']),
        isPrimaryKey: Boolean(row['is_primary']),
        defaultExpression:
          row['default_expression'] === null || row['default_expression'] === undefined
            ? undefined
            : String(row['default_expression']),
      });
      columnsByTable.set(key, list);
    }

    const schemas = new Set<string>();
    const tables: SchemaTable[] = tablesResult.rows.map((row) => {
      const schema = String(row['schema']);
      const name = String(row['name']);
      schemas.add(schema);
      return {
        schema,
        name,
        qualified: schema === 'public' ? name : `${schema}.${name}`,
        rows: Number(row['rows']),
        bytes: Number(row['bytes']),
        columns: columnsByTable.get(`${schema}.${name}`) ?? [],
        partitioned: Boolean(row['partitioned']),
      };
    });

    const qualify_ = (schema: string, name: string): string =>
      schema === 'public' ? name : `${schema}.${name}`;

    const foreignKeys: ForeignKeyInfo[] = keysResult.rows.map((row) => ({
      name: String(row['name']),
      fromTable: qualify_(String(row['from_schema']), String(row['from_table'])),
      fromColumns: (row['from_columns'] as string[] | null) ?? [],
      toTable: qualify_(String(row['to_schema']), String(row['to_table'])),
      toColumns: (row['to_columns'] as string[] | null) ?? [],
    }));

    return {
      tables,
      foreignKeys,
      schemas: [...schemas].sort((a, b) =>
        a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b),
      ),
    };
  }

  /**
   * One table in full: structure, the rules on it, and actual rows.
   *
   * The row count is exact where that is affordable and the planner's estimate
   * where it is not. Counting 600,000 rows is a second or so; on a table where
   * it would blow the statement timeout the estimate is used instead and
   * labelled as one, rather than the drawer showing nothing.
   */
  async tableDetail(table: string, sampleLimit: number, filter?: string): Promise<TableDetail> {
    const [columns, primaryKey] = await Promise.all([
      this.tableColumns(table),
      this.primaryKeyColumns(table),
    ]);

    if (columns.length === 0) {
      throw new Error(`Table not found: ${table}`);
    }

    const indexesResult = await this.probe(
      `SELECT i.relname AS name,
              ix.indisunique AS "unique",
              ix.indisprimary AS "primary",
              pg_get_indexdef(ix.indexrelid) AS definition,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a
                   ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS columns
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE ix.indrelid = to_regclass($1)
        ORDER BY ix.indisprimary DESC, i.relname`,
      [table],
    );

    const constraintsResult = await this.probe(
      `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = to_regclass($1)
        ORDER BY contype, conname`,
      [table],
    );

    // Ordered by primary key so the sample is stable between openings; an
    // unordered LIMIT can return different rows each time, which makes the
    // drawer look like it is showing changing data when nothing has changed.
    const order = primaryKey.length > 0 ? ` ORDER BY ${primaryKey.map(quoteIdent).join(', ')}` : '';

    // Finding one row among a quarter of a million is the difference between
    // being able to edit your data and being able to edit its first 25 rows.
    // Every column is cast to text and matched case-insensitively, which is
    // slow and exactly right for the question — the user is looking for a
    // value, not writing a query, and does not know or care which column holds
    // it. The search term is bound; only the column names are interpolated,
    // and those come from the catalog.
    const search = filter?.trim();
    const where =
      search && columns.length > 0
        ? ` WHERE ${columns
            .map((column) => `CAST(${quoteIdent(column.name)} AS text) ILIKE $1`)
            .join(' OR ')}`
        : '';

    const sampleResult = await this.probe(
      `SELECT * FROM ${qualify(table)}${where}${order} LIMIT ${Math.max(1, Math.floor(sampleLimit))}`,
      where ? [`%${search}%`] : undefined,
    );

    let rows: number;
    let rowsEstimated = false;
    try {
      rows = await this.countRows(table);
    } catch {
      rows = (await this.tableStats(table)).estimatedRows;
      rowsEstimated = true;
    }

    return {
      table,
      columns,
      primaryKey,
      rows,
      rowsEstimated,
      sample: sampleResult.rows,
      ...(search ? { filter: search, matched: sampleResult.rows.length } : {}),
      indexes: indexesResult.rows.map((row) => ({
        name: String(row['name']),
        columns: (row['columns'] as string[] | null) ?? [],
        unique: Boolean(row['unique']),
        primary: Boolean(row['primary']),
        definition: String(row['definition']),
      })),
      constraints: constraintsResult.rows.map((row) => ({
        name: String(row['name']),
        type: constraintType(String(row['type'])),
        definition: String(row['definition']),
      })),
    };
  }

  /**
   * Who is holding a lock on this table right now.
   *
   * `idle in transaction` sessions are included deliberately, and are usually
   * the worst offenders: they are doing nothing at all and still holding
   * everything they touched. A migration queued behind one waits for a human
   * to notice.
   */
  async lockHolders(table: string): Promise<LockHolder[]> {
    const { rows } = await this.probe(
      `SELECT a.pid,
              a.state,
              COALESCE(a.application_name, '') AS application_name,
              COALESCE(a.query, '') AS query,
              EXTRACT(EPOCH FROM (now() - COALESCE(
                CASE WHEN a.state = 'idle in transaction' THEN a.state_change ELSE a.query_start END,
                a.backend_start
              )))::float8 AS seconds,
              l.mode AS lock_mode
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.relation = to_regclass($1)
          AND l.granted
          AND a.pid <> pg_backend_pid()
        ORDER BY seconds DESC`,
      [table],
    );

    return rows.map((row) => ({
      pid: Number(row['pid']),
      state: String(row['state'] ?? 'unknown'),
      applicationName: String(row['application_name'] ?? ''),
      query: String(row['query'] ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 200),
      seconds: Math.max(0, Number(row['seconds'] ?? 0)),
      lockMode: String(row['lock_mode'] ?? ''),
    }));
  }

  /**
   * Walks the cascade a delete would set off.
   *
   * Breadth-first over the foreign keys that point *at* each table, counting
   * the rows that would go at every level. The counting query is built by
   * nesting `IN (SELECT …)` rather than by materialising ids, because the
   * interesting cases involve hundreds of thousands of rows and shipping their
   * keys back and forth would be slower than the delete.
   *
   * Bounded: cascades can be deep and cyclic, and a preview that takes longer
   * than the statement it is previewing is not a preview.
   */
  async cascadeImpact(
    table: string,
    where: string,
    params: readonly unknown[],
  ): Promise<CascadeNode> {
    const MAX_DEPTH = 4;
    const MAX_TABLES = 25;

    const keys = await this.probe(
      `SELECT c.conname AS name,
              src.relname AS from_table,
              tgt.relname AS to_table,
              c.confdeltype AS action,
              (SELECT array_agg(att.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS from_columns,
              (SELECT array_agg(att.attname::text ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = c.confrelid AND att.attnum = k.attnum) AS to_columns
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
         JOIN pg_class tgt ON tgt.oid = c.confrelid
        WHERE c.contype = 'f'`,
    );

    const referencing = new Map<string, ReferencingKey[]>();
    for (const row of keys.rows) {
      const target = String(row['to_table']);
      const list = referencing.get(target) ?? [];
      list.push({
        name: String(row['name']),
        fromTable: String(row['from_table']),
        fromColumns: (row['from_columns'] as string[] | null) ?? [],
        toColumns: (row['to_columns'] as string[] | null) ?? [],
        action: cascadeAction(String(row['action'])),
      });
      referencing.set(target, list);
    }

    const rootRows = await this.countRows(table, where, params);
    let budget = MAX_TABLES;

    const walk = async (
      current: string,
      predicate: string,
      depth: number,
      seen: ReadonlySet<string>,
    ): Promise<CascadeNode[]> => {
      if (depth >= MAX_DEPTH) {
        return [];
      }

      const children: CascadeNode[] = [];

      for (const key of referencing.get(bareName(current)) ?? []) {
        // A cycle would otherwise walk forever, and a table reached twice would
        // be double counted.
        if (seen.has(key.fromTable) || budget <= 0) {
          continue;
        }
        budget--;

        // Rows in the child whose key points at a row the parent is losing.
        const childPredicate =
          `(${key.fromColumns.map(quoteIdent).join(', ')}) IN ` +
          `(SELECT ${key.toColumns.map(quoteIdent).join(', ')} FROM ${qualify(current)} WHERE ${predicate})`;

        let rows = 0;
        try {
          rows = await this.countRows(key.fromTable, childPredicate, params);
        } catch {
          continue; // a cross-schema or unusual key; skip rather than guess
        }

        if (rows === 0) {
          continue;
        }

        const nested =
          key.action === 'cascade'
            ? await walk(
                key.fromTable,
                childPredicate,
                depth + 1,
                new Set([...seen, key.fromTable]),
              )
            : [];

        children.push({
          table: key.fromTable,
          rows,
          via: { constraint: key.name, action: key.action },
          children: nested,
        });
      }

      return children;
    };

    const children = await walk(table, where, 0, new Set([bareName(table)]));

    return {
      table,
      rows: rootRows,
      children,
      ...(budget <= 0 ? { truncated: `stopped after ${MAX_TABLES} related tables` } : {}),
    };
  }

  /**
   * Rows matching a predicate.
   *
   * The rows behind a blocking count. A read, capped, under the ordinary
   * statement timeout — this runs against a table someone is about to migrate,
   * and an unbounded scan there is the very thing the tool exists to warn
   * about.
   */
  async rowsMatching(
    table: string,
    where: string,
    limit: number,
    orderBy?: string,
  ): Promise<Row[]> {
    const order = orderBy ? ` ORDER BY ${orderBy}` : '';
    const { rows } = await this.probe(
      `SELECT * FROM ${qualify(table)} WHERE ${where}${order} LIMIT ${Math.max(1, Math.floor(limit))}`,
    );
    return rows;
  }

  async sampleRows(table: string, pks: PrimaryKeyValue[], limit: number): Promise<Row[]> {
    if (pks.length === 0) {
      return [];
    }

    const columns = Object.keys(pks[0]!);
    if (columns.length === 0) {
      return [];
    }

    const params: unknown[] = [];
    const tuples = pks.map((pk) => {
      const placeholders = columns.map((c) => {
        params.push(pk[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    const key = columns.map(quoteIdent).join(', ');
    params.push(limit);

    const { rows } = await this.probe(
      `SELECT * FROM ${qualify(table)} WHERE (${key}) IN (${tuples.join(', ')}) LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  /**
   * `analyze: true` really executes the statement, so it is only ever legal
   * inside a rolled-back transaction. This method runs outside one, and
   * therefore refuses.
   */
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
    const { rows } = await this.probe(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return { raw: rows[0]?.['QUERY PLAN'] };
  }

  // ---- triggers ----------------------------------------------------------

  /**
   * What fires when this table is written to, and what of it escapes.
   *
   * The escape patterns are matched against the trigger function's source, one
   * level deep. That is not a proof of safety and the wording everywhere says
   * so — a function calling another function is beyond what this can see.
   * It is, however, enough to catch the cases that actually happen: a
   * notification sent to a queue, a row pushed through a foreign table, an
   * HTTP call made from a trigger.
   */
  async triggers(table: string): Promise<TriggerInfo[]> {
    const { rows } = await this.probe(
      `SELECT t.tgname AS name,
              p.proname AS function_name,
              t.tgenabled <> 'D' AS enabled,
              t.tgtype AS type_bits,
              COALESCE(p.prosrc, '') AS source
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = to_regclass($1)
          AND NOT t.tgisinternal
        ORDER BY t.tgname`,
      [table],
    );

    return rows.map((row) => {
      // tgtype is a bitmask: 1 = row-level, 2 = BEFORE, 4 = INSERT,
      // 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE, 64 = INSTEAD OF.
      const bits = Number(row['type_bits'] ?? 0);
      const events: string[] = [];
      if (bits & 4) {
        events.push('insert');
      }
      if (bits & 8) {
        events.push('delete');
      }
      if (bits & 16) {
        events.push('update');
      }
      if (bits & 32) {
        events.push('truncate');
      }

      return {
        name: String(row['name']),
        table,
        timing: bits & 64 ? ('instead of' as const) : bits & 2 ? ('before' as const) : ('after' as const),
        events,
        functionName: String(row['function_name']),
        enabled: Boolean(row['enabled']),
        escapes: escapesRollback(String(row['source'] ?? '')),
      };
    });
  }

  // ---- schema health -----------------------------------------------------

  /**
   * Four questions about the schema, asked in four queries.
   *
   * Split rather than joined into one: each reads a different catalogue, the
   * results are shown in different places, and a single query that answered all
   * four would be unreadable and no faster.
   */
  async schemaHealth(): Promise<SchemaHealth> {
    // Postgres caches the statistics view within a backend, and this adapter
    // holds one connection for the life of the session. Without this, asking a
    // second time returns the first answer — an index scanned since the last
    // check would still be listed as unread, which is the one number here
    // people act on.
    await this.probe('SELECT pg_stat_clear_snapshot()');

    const [since, unused, redundant, foreignKeys, tables] = [
      await this.statsResetAt(),
      await this.unusedIndexes(),
      await this.redundantIndexes(),
      await this.unindexedForeignKeys(),
      await this.tableHealth(),
    ];

    return {
      statsSince: since,
      unusedIndexes: unused,
      redundantIndexes: redundant,
      unindexedForeignKeys: foreignKeys,
      tables,
    };
  }

  /**
   * When the statistics being read began accumulating.
   *
   * `stats_reset` is null on a database whose statistics have never been reset,
   * in which case the server's start time is the honest answer — and on a
   * platform that suspends idle computes, that can be minutes ago.
   */
  private async statsResetAt(): Promise<Date | null> {
    const { rows } = await this.probe(
      `SELECT COALESCE(
                (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
                pg_postmaster_start_time()
              ) AS since`,
    );
    const since = rows[0]?.['since'];
    return since instanceof Date ? since : null;
  }

  private async unusedIndexes(): Promise<UnusedIndex[]> {
    const { rows } = await this.probe(
      // Primary keys and unique constraints are excluded because they are not
      // there to be read: they enforce a rule, and dropping one because nothing
      // scanned it would drop the rule with it.
      `SELECT s.relname       AS table_name,
              s.indexrelname  AS index_name,
              s.idx_scan      AS scans,
              pg_relation_size(s.indexrelid)::bigint AS bytes,
              pg_get_indexdef(s.indexrelid) AS definition
         FROM pg_stat_user_indexes s
         JOIN pg_index i ON i.indexrelid = s.indexrelid
        WHERE NOT i.indisprimary
          AND NOT i.indisunique
          AND i.indisvalid
          AND s.schemaname NOT IN ('pg_catalog', 'information_schema')
          AND s.idx_scan = 0
        ORDER BY bytes DESC`,
    );

    return rows.map((row) => ({
      table: String(row['table_name']),
      index: String(row['index_name']),
      scans: Number(row['scans'] ?? 0),
      bytes: Number(row['bytes'] ?? 0),
      definition: String(row['definition'] ?? ''),
    }));
  }

  /**
   * Indexes another index already covers.
   *
   * A btree on (a) answers nothing that a btree on (a, b) does not, so the
   * shorter one is pure write overhead. Compared on the leading columns, which
   * is what "covers" means to the planner.
   */
  private async redundantIndexes(): Promise<RedundantIndex[]> {
    const { rows } = await this.probe(
      `WITH indexes AS (
         SELECT i.indexrelid,
                i.indrelid,
                i.indexrelid::regclass::text AS index_name,
                i.indrelid::regclass::text   AS table_name,
                string_to_array(i.indkey::text, ' ')::int2[] AS columns,
                i.indisunique,
                i.indisprimary
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE i.indisvalid
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND i.indexprs IS NULL
            AND i.indpred IS NULL
       )
       SELECT short.table_name,
              short.index_name AS redundant,
              long.index_name  AS covered_by,
              pg_relation_size(short.indexrelid)::bigint AS bytes
         FROM indexes short
         JOIN indexes long
           ON long.indrelid = short.indrelid
          AND long.indexrelid <> short.indexrelid
          AND array_length(long.columns, 1) > array_length(short.columns, 1)
          AND long.columns[1:array_length(short.columns, 1)] = short.columns
        WHERE NOT short.indisprimary
          AND NOT short.indisunique
        ORDER BY bytes DESC`,
    );

    return rows.map((row) => ({
      table: String(row['table_name']),
      index: String(row['redundant']),
      coveredBy: String(row['covered_by']),
      bytes: Number(row['bytes'] ?? 0),
    }));
  }

  private async unindexedForeignKeys(): Promise<UnindexedForeignKey[]> {
    const { rows } = await this.probe(
      `SELECT c.conname AS constraint_name,
              c.conrelid::regclass::text  AS table_name,
              c.confrelid::regclass::text AS referenced_table,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ) AS columns,
              GREATEST(rel.reltuples, 0)::bigint AS rows_estimate
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND NOT EXISTS (
                SELECT 1 FROM pg_index i
                 WHERE i.indrelid = c.conrelid
                   AND i.indisvalid
                   -- An index serves the key when the key's columns are its
                   -- leading ones, in order. Anything else the planner ignores.
                   AND (string_to_array(i.indkey::text, ' ')::int2[])
                       [1:array_length(c.conkey, 1)] = c.conkey::int2[]
              )
        ORDER BY rows_estimate DESC`,
    );

    return rows.map((row) => ({
      constraint: String(row['constraint_name']),
      table: String(row['table_name']),
      referencedTable: String(row['referenced_table']),
      columns: (row['columns'] as string[] | null) ?? [],
      rows: Number(row['rows_estimate'] ?? 0),
    }));
  }

  private async tableHealth(): Promise<TableHealth[]> {
    const { rows } = await this.probe(
      // Live rows come from pg_class rather than from n_live_tup. The two
      // usually agree, but n_live_tup can sit at zero after a bulk load until
      // something touches the table again, and reltuples is what the planner
      // itself reads — so this stays consistent with every other row count in
      // the extension.
      `SELECT t.relname AS table_name,
              GREATEST(c.reltuples, 0)::bigint AS live_rows,
              t.n_dead_tup::bigint AS dead_rows,
              t.n_mod_since_analyze::bigint AS modified,
              GREATEST(t.last_vacuum, t.last_autovacuum)   AS vacuumed,
              GREATEST(t.last_analyze, t.last_autoanalyze) AS analyzed,
              pg_total_relation_size(t.relid)::bigint AS bytes
         FROM pg_stat_user_tables t
         JOIN pg_class c ON c.oid = t.relid
        WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY bytes DESC`,
    );

    return rows.map((row) => ({
      table: String(row['table_name']),
      liveRows: Number(row['live_rows'] ?? 0),
      deadRows: Number(row['dead_rows'] ?? 0),
      modifiedSinceAnalyze: Number(row['modified'] ?? 0),
      lastVacuum: row['vacuumed'] instanceof Date ? (row['vacuumed'] as Date) : null,
      lastAnalyze: row['analyzed'] instanceof Date ? (row['analyzed'] as Date) : null,
      bytes: Number(row['bytes'] ?? 0),
    }));
  }

  // ---- index experiments -------------------------------------------------

  async supportsHypotheticalIndexes(): Promise<boolean> {
    const { rows } = await this.probe(`SELECT 1 FROM pg_extension WHERE extname = 'hypopg'`);
    return rows.length > 0;
  }

  async testIndex(
    indexSql: string,
    query: string,
    params: readonly unknown[],
    options: { readonly build: boolean },
  ): Promise<IndexExperiment> {
    if (await this.supportsHypotheticalIndexes()) {
      return this.hypotheticalIndexTest(indexSql, query, params);
    }
    if (!options.build) {
      throw new HypotheticalIndexUnavailableError();
    }
    return this.builtIndexTest(indexSql, query, params);
  }

  /**
   * The no-lock path.
   *
   * hypopg registers the index in the planner's catalogue and nowhere else, so
   * the answer comes back in milliseconds on a table of any size and nothing
   * on disk changes. The catch is that no rows are ever read through it: there
   * are estimates and no timings, which is honest — a cost the planner has
   * computed beats a millisecond figure nobody measured.
   *
   * hypopg state is per-session and this adapter holds one connection, so the
   * whole experiment runs inside a single serialized block. Interleaving
   * another caller's EXPLAIN between the create and the reset would silently
   * plan their query against an index that does not exist.
   */
  private async hypotheticalIndexTest(
    indexSql: string,
    query: string,
    params: readonly unknown[],
  ): Promise<IndexExperiment> {
    return this.serialize(async () => {
      const client = this.requireClient();
      const bound = params.length > 0 ? [...params] : undefined;

      const explain = async (): Promise<QueryPlan> => {
        const result = await client.query(`EXPLAIN (FORMAT JSON) ${query}`, bound);
        return { raw: result.rows[0]?.['QUERY PLAN'] };
      };

      // Reset first as well as last: a previous run that died mid-experiment
      // would otherwise leave an index in the planner's head and make the
      // "before" plan a lie.
      await client.query('SELECT hypopg_reset()');
      const before = await explain();

      try {
        const created = await client.query('SELECT indexname FROM hypopg_create_index($1)', [
          indexSql,
        ]);
        const name = String(created.rows[0]?.['indexname'] ?? '');
        const after = await explain();

        return {
          method: 'hypothetical',
          before,
          after,
          used: name.length > 0 && indexNames(after).has(name),
          beforeCost: totalCost(before),
          afterCost: totalCost(after),
          note:
            'Estimated, not timed: the index was never built, so no rows were read ' +
            'through it. The planner scored both plans against the same statistics.',
        };
      } finally {
        await client.query('SELECT hypopg_reset()').catch(() => undefined);
      }
    });
  }

  /**
   * The measured path, for databases without hypopg.
   *
   * Builds the index for real inside a transaction that is rolled back, which
   * gives genuine timings and leaves nothing behind — but does take the lock
   * and do the work of a real CREATE INDEX while it runs. That is why nothing
   * reaches here without the caller explicitly asking for it.
   *
   * The "before" plan is run twice and the second reading kept. The first run
   * warms the cache, and comparing a cold "before" against a warm "after"
   * would credit the index with an improvement that was really the page cache.
   */
  private async builtIndexTest(
    indexSql: string,
    query: string,
    params: readonly unknown[],
  ): Promise<IndexExperiment> {
    return this.withRollback(async (tx) => {
      const explain = async (): Promise<QueryPlan> => {
        const result = await tx.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
          params.length > 0 ? params : undefined,
        );
        return { raw: result.rows[0]?.['QUERY PLAN'] };
      };

      await explain();
      const before = await explain();
      const existing = indexNames(before);

      await tx.query(indexSql);
      const after = await explain();

      const fresh = [...indexNames(after)].filter((name) => !existing.has(name));
      return {
        method: 'built',
        before,
        after,
        used: fresh.length > 0,
        beforeCost: totalCost(before),
        afterCost: totalCost(after),
        beforeMs: executionMs(before),
        afterMs: executionMs(after),
        note:
          'Measured by building the index inside a transaction that was rolled back. ' +
          'Nothing was kept, but the build itself took the lock a real one would.',
      };
    });
  }

  // ---- internals --------------------------------------------------------

/**
   * Opens a fresh socket after the old one died.
   *
   * The connection string is still in `config` and nowhere else — it was never
   * written to disk — so reconnecting needs nothing from the user.
   */
  private async reconnect(): Promise<void> {
    const config = this.config;
    if (!config) {
      throw new Error('Not connected.');
    }

    const dead = this.client;
    this.client = null;
    this.broken = false;
    // Ended rather than left to be collected: an abandoned client keeps a
    // handle open and, on some failures, keeps retrying on its own.
    await dead?.end().catch(() => undefined);

    await this.open(config);
  }

  /**
   * Runs something, and if the connection turns out to be dead, opens a new
   * one and runs it again.
   *
   * Once only. A second failure is a failure, not a pattern to keep repeating
   * at a server that is telling us something.
   */
  private async withReconnect<T>(work: () => Promise<T>): Promise<T> {
    try {
      if (this.broken) {
        await this.reconnect();
      }
      return await work();
    } catch (error) {
      if (!isConnectionDead(error)) {
        throw error;
      }
      await this.reconnect();
      return work();
    }
  }

  private async probe(sql: string, params?: readonly unknown[]): Promise<QueryResult> {
    return this.serialize(() =>
      // A read is idempotent, so running it again on a new socket produces the
      // same answer it would have produced on the old one.
      this.withReconnect(async () => {
        const client = this.requireClient();
        const result = await client.query(sql, params ? [...params] : undefined);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      }),
    );
  }

  /** Serializes work on the single connection. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    // Keep the chain alive even when `run` rejects, so one failure does not
    // poison every subsequent call.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    return this.client;
  }
}

/** Quotes a possibly schema-qualified table name. */
export function qualify(table: string): string {
  return table
    .split('.')
    .map((part) => quoteIdent(part.trim()))
    .join('.');
}

export function quoteIdent(name: string): string {
  const bare = name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
  return `"${bare.replace(/"/g, '""')}"`;
}

/** The table name without its schema, for matching against pg_class.relname. */
function bareName(table: string): string {
  const parts = table.split('.');
  const last = parts[parts.length - 1] ?? table;
  return last.trim().replace(/^"|"$/g, '');
}

/** pg_constraint.contype is a single character; this is what each one means. */
function constraintType(code: string): ConstraintInfo['type'] {
  switch (code) {
    case 'p':
      return 'primary key';
    case 'f':
      return 'foreign key';
    case 'u':
      return 'unique';
    case 'c':
      return 'check';
    case 'x':
      return 'exclusion';
    default:
      return 'other';
  }
}

/** A foreign key pointing at a table, as the cascade walk needs it. */
interface ReferencingKey {
  name: string;
  fromTable: string;
  fromColumns: string[];
  toColumns: string[];
  action: CascadeAction;
}

/** pg_constraint.confdeltype is a single character. */
function cascadeAction(code: string): CascadeAction {
  switch (code) {
    case 'c':
      return 'cascade';
    case 'n':
      return 'set null';
    case 'd':
      return 'set default';
    case 'r':
      return 'restrict';
    default:
      return 'no action';
  }
}

function readCount(rows: readonly Row[]): number {
  return Number(rows[0]?.['n'] ?? 0);
}

/**
 * Savepoint names are interpolated into SQL, so they are restricted to bare
 * identifiers. Every caller passes a constant today; this makes sure that
 * stays true even if one day a caller passes something derived.
 */
function savepointName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid savepoint name: ${name}`);
  }
  return name;
}


/**
 * Things in a trigger function that a ROLLBACK does not take back.
 *
 * Matched on the function source rather than inferred from anything the
 * catalogue records, because the catalogue records nothing about this. Reported
 * as "worth looking at", never as a verdict: an empty list means nothing
 * obvious was found one level deep, not that the trigger is contained.
 */
function escapesRollback(source: string): string[] {
  const found: string[] = [];
  const check = (pattern: RegExp, description: string): void => {
    if (pattern.test(source)) {
      found.push(description);
    }
  };

  // NOTIFY is delivered at commit, so a rolled-back preview never sends it —
  // but a listener on a replica or a queue consumer reading the same channel
  // is a common enough pattern that saying nothing feels worse than saying it.
  check(/\bpg_notify\s*\(|\bNOTIFY\s+\w/i, 'sends a notification (pg_notify / NOTIFY)');
  check(/\bdblink\w*\s*\(/i, 'opens a connection to another database (dblink)');
  check(/\bhttp(_get|_post|_put|_delete|_request)?\s*\(/i, 'makes an HTTP request');
  check(/\bCOPY\b[\s\S]{0,120}\bTO\s+PROGRAM\b/i, 'runs a shell command (COPY TO PROGRAM)');
  check(/\bpg_background_launch\s*\(/i, 'starts work in a separate transaction (pg_background)');
  check(/\bpg_read_file\s*\(|\bpg_write_file\s*\(|\blo_export\s*\(/i, 'touches the server filesystem');
  check(/\bperform\s+\w*\.?send/i, 'calls something named "send"');

  return found;
}


/**
 * Whether this failure means the socket is gone rather than the query was bad.
 *
 * `pg` reports a dead client with one sentence and no code, which is why the
 * text is matched as well as the codes: "Client has encountered a connection
 * error and is not queryable" is the whole of what it says, and it says it for
 * every query afterwards, for ever.
 */
export function isConnectionDead(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = String((error as { code?: unknown }).code ?? '');
  if (
    [
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'ENOTCONN',
      'ECONNREFUSED',
      // Postgres shutting the session down on purpose.
      '57P01', // admin_shutdown
      '57P02', // crash_shutdown
      '57P03', // cannot_connect_now
      '08006', // connection_failure
      '08003', // connection_does_not_exist
      '08000', // connection_exception
    ].includes(code)
  ) {
    return true;
  }

  const message = String((error as { message?: unknown }).message ?? '');
  return (
    /connection error and is not queryable/i.test(message) ||
    /Connection terminated/i.test(message) ||
    /server closed the connection unexpectedly/i.test(message) ||
    /Client has already been connected/i.test(message) ||
    /terminating connection due to administrator command/i.test(message)
  );
}


/**
 * Thrown when the connection died during an apply.
 *
 * The distinction it carries is the whole reason it exists: a failure before
 * the COMMIT means nothing happened, and a failure during one means nobody
 * knows. Reporting both as "apply failed" would leave someone to find out by
 * looking, which is fine — as long as they are told to look.
 */
export class UncertainApplyError extends Error {
  constructor(cause: string) {
    super(
      `The connection died while applying, so Dry Run does not know whether the ` +
        `changes went through (${cause}). It has not retried, because applying twice ` +
        `is worse than applying once. Check the database before running this again.`,
    );
    this.name = 'UncertainApplyError';
  }
}
