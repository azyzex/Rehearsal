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
} from './types';
import { CommittableStatement, CommittedResult, runCommittedOn } from './commit';
import { findTransactionControl } from '../parser/transactionControl';

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
  private config: ConnectionConfig | null = null;
  /** Tail of the serialization queue. */
  private queue: Promise<unknown> = Promise.resolve();

  async connect(config: ConnectionConfig): Promise<void> {
    if (this.client) {
      throw new Error('Already connected. Dispose the adapter before reconnecting.');
    }

    const client = new Client({
      connectionString: config.connectionString,
      application_name: config.applicationName,
      // Client-side ceiling, so a hung server cannot hang the extension host.
      query_timeout: config.statementTimeoutMs + 1000,
      connectionTimeoutMillis: 10_000,
    });

    await client.connect();
    this.client = client;
    this.config = config;

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
    return this.serialize(async () => {
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
        await client.query(`SET LOCAL statement_timeout = ${Math.floor(config.statementTimeoutMs)}`);
        await client.query(`SET LOCAL lock_timeout = ${Math.floor(config.lockTimeoutMs)}`);
        return await fn(tx);
      } finally {
        // Unconditional. If this throws, the connection is already unusable,
        // in which case the transaction is dead and nothing was persisted.
        await client.query('ROLLBACK').catch(() => {
          /* connection lost: the server discards the transaction for us */
        });
      }
    });
  }

  /**
   * Applies previously-previewed statements for real.
   *
   * The only write path in the adapter. It delegates to `commit.ts`, which is
   * the sole file exempt from the no-commit rule, so that this capability lives
   * somewhere it can be read in one sitting rather than being spread out.
   */
  async runCommitted(statements: readonly CommittableStatement[]): Promise<CommittedResult> {
    return this.serialize(async () => {
      const config = this.config!;
      return runCommittedOn(
        this.requireClient(),
        {
          statementTimeoutMs: config.statementTimeoutMs,
          lockTimeoutMs: config.lockTimeoutMs,
        },
        statements,
      );
    });
  }

  // ---- read-only probes -------------------------------------------------

  async countRows(
    table: string,
    where?: string,
    params: readonly unknown[] = [],
  ): Promise<number> {
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
    return { groups: Number(row?.['groups'] ?? 0), rows: Number(row?.['rows'] ?? 0) };
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
              EXISTS (
                SELECT 1 FROM pg_index i
                 WHERE i.indrelid = a.attrelid
                   AND i.indisprimary
                   AND a.attnum = ANY(i.indkey)
              ) AS is_primary
         FROM pg_attribute a
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
              COALESCE(pk.is_primary, false) AS is_primary
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
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
      schemas: [...schemas].sort((a, b) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b))),
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
      query: String(row['query'] ?? '').replace(/\s+/g, ' ').slice(0, 200),
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
            ? await walk(key.fromTable, childPredicate, depth + 1, new Set([...seen, key.fromTable]))
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

  // ---- internals --------------------------------------------------------

  private async probe(sql: string, params?: readonly unknown[]): Promise<QueryResult> {
    return this.serialize(async () => {
      const client = this.requireClient();
      const result = await client.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    });
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
