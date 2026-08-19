import { Client } from 'pg';
import {
  ConnectionConfig,
  DatabaseAdapter,
  PrimaryKeyValue,
  QueryPlan,
  QueryResult,
  Row,
  TableStats,
  Transaction,
  TransactionControlError,
} from './types';
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

  // ---- read-only probes -------------------------------------------------

  async countRows(table: string, where?: string): Promise<number> {
    const clause = where && where.trim().length > 0 ? ` WHERE ${where}` : '';
    const { rows } = await this.probe(
      `SELECT COUNT(*)::bigint AS n FROM ${qualify(table)}${clause}`,
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

  async tableStats(table: string): Promise<TableStats> {
    const { rows } = await this.probe(
      `SELECT n.nspname AS schema,
              c.relname AS name,
              GREATEST(c.reltuples, 0)::bigint AS estimated_rows,
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

    return {
      schema: String(row['schema']),
      table: String(row['name']),
      estimatedRows: Number(row['estimated_rows']),
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
  async explain(sql: string, analyze: boolean): Promise<QueryPlan> {
    if (analyze) {
      throw new Error(
        'EXPLAIN ANALYZE executes the statement for real. Run it through withRollback instead.',
      );
    }
    const { rows } = await this.probe(`EXPLAIN (FORMAT JSON) ${sql}`);
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

function readCount(rows: readonly Row[]): number {
  return Number(rows[0]?.['n'] ?? 0);
}
