import { runCommittedOnSqlite } from './commit';
import {
  CascadeAction,
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
  TableDetail,
  TableStats,
  Transaction,
  TransactionControlError,
  TriggerInfo,
  UnindexedForeignKey,
} from './types';

/**
 * SQLite — the fourth engine, and the one that is not a server.
 *
 * It earns its place by being the opposite of MySQL on the axis this whole
 * project is built around. MySQL has every feature of a large database and
 * cannot take a schema change back; SQLite has almost no features and can. An
 * `ALTER TABLE` here runs inside a transaction and a `ROLLBACK` undoes it,
 * exactly as it does on Postgres, so a preview against SQLite is a real
 * execution and a real rollback rather than a count.
 *
 * What it does not have is `ALTER TABLE`. There is `ADD COLUMN`, `DROP COLUMN`,
 * `RENAME TABLE` and `RENAME COLUMN`, and that is the entire list. Changing a
 * column's type, making one `NOT NULL`, adding a constraint — none of them
 * exist. The documented way to do any of them is to build a new table, copy
 * every row into it, drop the old one and rename: twelve steps, in a specific
 * order, with the foreign keys turned off in the middle. That is not a
 * limitation this tool can hide, and it is one worth being loud about, because
 * the rebuild is where the data actually gets lost.
 *
 * Two more things shape everything below.
 *
 * **Foreign keys are off by default.** `PRAGMA foreign_keys` is per-connection
 * and defaults to off, which means a schema full of `REFERENCES` clauses may be
 * enforcing none of them. A cascade that will not happen is worse news than one
 * that will, and the pragma is read rather than assumed.
 *
 * **There are no statistics and no other sessions.** No `pg_stat_activity` to
 * ask who is holding a lock, no index usage counters, no planner row estimates.
 * Where a probe has no honest answer here it says so; none of them return zero
 * and hope.
 *
 * The driver is Node's own `node:sqlite`, required at connect time rather than
 * imported at the top. It is still marked experimental, and on a runtime that
 * does not have it this adapter refuses to connect with a sentence explaining
 * why — which is better than the extension failing to load at all for the
 * people using the other three engines.
 */

/** The shape of `node:sqlite` this adapter uses. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Row[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  close(): void;
}

const CONTROL = /^\s*(begin|commit|rollback|end|savepoint|release)\b/i;

export class SqliteAdapter implements DatabaseAdapter {
  readonly engine = 'sqlite' as const;
  /**
   * True, and this is the interesting half of adding this engine: SQLite is
   * the second of the four that can take a schema change back.
   */
  readonly supportsTransactionalDDL = true;

  private db: SqliteDatabase | undefined;
  private file = '';
  /** Whether this connection is enforcing foreign keys at all. */
  private foreignKeysOn = false;

  async connect(config: ConnectionConfig): Promise<void> {
    const file = fileFrom(config.connectionString);

    let module: { DatabaseSync: new (path: string, options?: unknown) => SqliteDatabase };
    try {
      // Required here rather than imported at the top: `node:sqlite` does not
      // exist before Node 22, and a missing module at import time would stop
      // the whole extension from loading for people using the other engines.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      module = require('node:sqlite') as typeof module;
    } catch {
      throw new Error(
        'SQLite support needs Node 22 or newer, which provides the built-in ' +
          '`node:sqlite` module. This runtime does not have it, so Dry Run cannot ' +
          'open the database file.',
      );
    }

    this.db = new module.DatabaseSync(file);
    this.file = file;

    // Read rather than set. Turning foreign keys on would change how the
    // database behaves for the duration of the preview, which is exactly the
    // kind of quiet difference that makes a preview lie: the cascade it
    // measures has to be the cascade you would get.
    const pragma = this.db.prepare('PRAGMA foreign_keys').all()[0];
    this.foreignKeysOn = Boolean(Object.values(pragma ?? {})[0]);
  }

  async dispose(): Promise<void> {
    try {
      this.db?.close();
    } catch {
      // Closing a database that is already closed is not worth reporting.
    }
    this.db = undefined;
  }

  /**
   * Everything, inside a transaction that is always rolled back.
   *
   * The rollback is in a `finally`, like every other adapter here. What is
   * different is that DDL is allowed through: SQLite really does undo a
   * `CREATE TABLE` on rollback, so there is no reason to refuse one and every
   * reason to let the preview measure it properly.
   */
  async withRollback<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const db = this.require();
    db.exec('BEGIN');

    const tx: Transaction = {
      query: async (sql, params) => this.run(sql, params, true),
      savepoint: async (name) => {
        db.exec(`SAVEPOINT ${bareName(name)}`);
      },
      rollbackTo: async (name) => {
        db.exec(`ROLLBACK TO ${bareName(name)}`);
      },
    };

    try {
      return await fn(tx);
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A transaction the driver already ended is not a leak; there is
        // nothing left to take back.
      }
    }
  }

  // ---- read-only probes ----------------------------------------------------

  async countRows(table: string, where?: string, params: readonly unknown[] = []): Promise<number> {
    const clause = where ? ` WHERE ${where}` : '';
    const result = await this.probe(
      `SELECT count(*) AS n FROM ${quote(table)}${clause}`,
      params,
    );
    return Number(result[0]?.['n'] ?? 0);
  }

  async countNonNull(table: string, column: string): Promise<number> {
    const result = await this.probe(
      `SELECT count(*) AS n FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`,
    );
    return Number(result[0]?.['n'] ?? 0);
  }

  async countViolating(table: string, predicate: string): Promise<number> {
    const result = await this.probe(
      `SELECT count(*) AS n FROM ${quote(table)} WHERE NOT (${predicate})`,
    );
    return Number(result[0]?.['n'] ?? 0);
  }

  async countOrphans(
    table: string,
    columns: readonly string[],
    referencedTable: string,
    referencedColumns: readonly string[],
  ): Promise<number> {
    const on = columns
      .map((column, index) => `c.${quote(column)} = p.${quote(referencedColumns[index] ?? column)}`)
      .join(' AND ');
    const present = columns.map((column) => `c.${quote(column)} IS NOT NULL`).join(' AND ');

    const result = await this.probe(
      `SELECT count(*) AS n
         FROM ${quote(table)} c
         LEFT JOIN ${quote(referencedTable)} p ON ${on}
        WHERE ${present} AND p.${quote(referencedColumns[0] ?? columns[0]!)} IS NULL`,
    );
    return Number(result[0]?.['n'] ?? 0);
  }

  async countDuplicates(
    table: string,
    columns: readonly string[],
  ): Promise<{ groups: number; rows: number }> {
    const list = columns.map(quote).join(', ');
    const result = await this.probe(
      `SELECT count(*) AS groups, COALESCE(sum(n), 0) AS rows FROM (
         SELECT count(*) AS n FROM ${quote(table)}
          GROUP BY ${list} HAVING count(*) > 1
       )`,
    );
    return {
      groups: Number(result[0]?.['groups'] ?? 0),
      rows: Number(result[0]?.['rows'] ?? 0),
    };
  }

  /**
   * Rows that would not survive a change of type.
   *
   * SQLite does not enforce column types — a column declared `INTEGER` holds
   * the string you put in it, and a `CAST` never fails, it just returns 0. So
   * the question is asked the only way it can be: convert and convert back, and
   * count the values that came back different.
   *
   * For a type SQLite has no affinity rule for, the honest answer is that it
   * cannot be tested, and that is what null means here.
   */
  async countCastFailures(
    table: string,
    column: string,
    newType: string,
  ): Promise<number | null> {
    const affinity = affinityOf(newType);
    if (!affinity) {
      return null;
    }
    if (affinity === 'TEXT' || affinity === 'BLOB') {
      // Everything converts to text, and the rebuild that would apply this
      // does not lose anything.
      return 0;
    }

    try {
      const result = await this.probe(
        `SELECT count(*) AS n FROM ${quote(table)}
          WHERE ${quote(column)} IS NOT NULL
            AND CAST(CAST(${quote(column)} AS ${affinity}) AS TEXT) <> CAST(${quote(column)} AS TEXT)`,
      );
      return Number(result[0]?.['n'] ?? 0);
    } catch {
      return null;
    }
  }

  /**
   * Rows and bytes.
   *
   * The row count is a real `count(*)` rather than a catalog estimate, because
   * SQLite keeps no estimate. That is affordable here in a way it would not be
   * on a large server database, and it is exact, which is better.
   */
  async tableStats(table: string): Promise<TableStats> {
    const rows = await this.countRows(table);

    // dbstat is a compile-time option and is often absent. A missing size is
    // reported as zero rather than as an error, since nothing depends on it
    // beyond one line of prose.
    let bytes = 0;
    try {
      const result = await this.probe(
        `SELECT COALESCE(sum(pgsize), 0) AS b FROM dbstat WHERE name = ?`,
        [bare(table)],
      );
      bytes = Number(result[0]?.['b'] ?? 0);
    } catch {
      bytes = 0;
    }

    return { schema: 'main', table: bare(table), estimatedRows: rows, totalBytes: bytes };
  }

  async sampleRows(table: string, pks: PrimaryKeyValue[], limit: number): Promise<Row[]> {
    if (pks.length === 0) {
      return [];
    }

    const keys = Object.keys(pks[0] ?? {});
    if (keys.length === 0) {
      return [];
    }

    const clause = pks
      .slice(0, limit)
      .map(() => `(${keys.map((key) => `${quote(key)} = ?`).join(' AND ')})`)
      .join(' OR ');
    const params = pks.slice(0, limit).flatMap((pk) => keys.map((key) => pk[key]));

    return this.probe(`SELECT * FROM ${quote(table)} WHERE ${clause} LIMIT ${Math.floor(limit)}`, params);
  }

  async primaryKeyColumns(table: string): Promise<string[]> {
    const info = await this.probe(`PRAGMA table_info(${quote(table)})`);
    return info
      .filter((row) => Number(row['pk'] ?? 0) > 0)
      .sort((a, b) => Number(a['pk']) - Number(b['pk']))
      .map((row) => String(row['name']));
  }

  async tableColumns(table: string): Promise<ColumnInfo[]> {
    const info = await this.probe(`PRAGMA table_info(${quote(table)})`);
    return info.map((row) => ({
      name: String(row['name']),
      // Declared, not enforced. Shown as declared because that is what the
      // schema says and what a rebuild would have to reproduce.
      type: String(row['type'] ?? '').toLowerCase() || 'blob',
      nullable: Number(row['notnull'] ?? 0) === 0,
      isPrimaryKey: Number(row['pk'] ?? 0) > 0,
      ...(row['dflt_value'] === null || row['dflt_value'] === undefined
        ? {}
        : { defaultExpression: String(row['dflt_value']) }),
    }));
  }

  async foreignKeys(tables: readonly string[]): Promise<ForeignKeyInfo[]> {
    const all = tables.length > 0 ? tables : await this.tableNames();
    const keys: ForeignKeyInfo[] = [];

    for (const table of all) {
      const rows = await this.probe(`PRAGMA foreign_key_list(${quote(table)})`).catch(() => []);

      // One row per column; rows sharing an `id` are one key.
      const byId = new Map<number, Row[]>();
      for (const row of rows) {
        const id = Number(row['id'] ?? 0);
        byId.set(id, [...(byId.get(id) ?? []), row]);
      }

      for (const [id, group] of byId) {
        const first = group[0]!;
        keys.push({
          // SQLite does not name foreign keys, so one is made from what
          // identifies it. A name is needed to talk about it at all.
          name: `${bare(table)}_fk_${id}`,
          fromTable: bare(table),
          fromColumns: group.map((row) => String(row['from'])),
          toTable: String(first['table']),
          toColumns: group.map((row) => String(row['to'] ?? '')).filter((name) => name.length > 0),
        });
      }
    }

    return keys.filter(
      (key) => tables.length === 0 || tables.includes(key.fromTable) || tables.includes(key.toTable),
    );
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const names = await this.tableNames();
    const tables = [];

    for (const name of names) {
      const stats = await this.tableStats(name).catch(() => ({
        estimatedRows: 0,
        totalBytes: 0,
      }));
      tables.push({
        schema: 'main',
        name,
        qualified: name,
        rows: stats.estimatedRows,
        bytes: stats.totalBytes,
        partitioned: false,
        columns: await this.tableColumns(name).catch(() => []),
      });
    }

    return { tables, foreignKeys: await this.foreignKeys([]), schemas: ['main'] };
  }

  async tableDetail(table: string, sampleLimit: number, filter?: string): Promise<TableDetail> {
    const columns = await this.tableColumns(table);
    const rows = await this.countRows(table);

    const where = filter
      ? columns.map((column) => `CAST(${quote(column.name)} AS TEXT) LIKE ?`).join(' OR ')
      : '';
    const params = filter ? columns.map(() => `%${filter}%`) : [];

    const sample = await this.probe(
      `SELECT * FROM ${quote(table)}${where ? ` WHERE ${where}` : ''} LIMIT ${Math.floor(sampleLimit)}`,
      params,
    ).catch(() => []);

    return {
      table: bare(table),
      columns,
      indexes: await this.indexesOf(table),
      constraints: await this.constraintsOf(table),
      primaryKey: await this.primaryKeyColumns(table),
      rows,
      rowsEstimated: false,
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
    return this.probe(
      `SELECT * FROM ${quote(table)} WHERE ${where}` +
        `${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${Math.floor(limit)}`,
    );
  }

  quoteIdentifier(name: string): string {
    return quote(name);
  }

  /**
   * Nobody. SQLite has one writer and no session catalog.
   *
   * Returning an empty list is the right answer rather than a missing one: the
   * question "who is holding a lock right now" genuinely has no other sessions
   * to name. What SQLite has instead is `SQLITE_BUSY`, which the statement gets
   * when it runs, not before.
   */
  async lockHolders(): Promise<LockHolder[]> {
    return [];
  }

  /**
   * What a delete takes with it — and whether it takes anything at all.
   *
   * `PRAGMA foreign_keys` is per connection, and in SQLite itself it is off by
   * default. So the same `ON DELETE CASCADE` is enforced or ignored depending on
   * which connection runs the delete, and Dry Run's connection is not the
   * application's.
   *
   * The rows are counted as though the keys are enforced, because that is the
   * larger blast radius and the one worth seeing. What cannot be assumed is
   * whether it will happen, so that is said rather than implied: with the pragma
   * off, none of these rows are deleted and the orphans are left behind instead
   * — which is a different problem and a quieter one.
   */
  async cascadeImpact(
    table: string,
    where: string,
    params: readonly unknown[] = [],
  ): Promise<CascadeNode> {
    const rows = await this.countRows(table, where, params);
    const root: CascadeNode = { table: bare(table), rows, children: [] };

    const children: CascadeNode[] = [];
    for (const name of await this.tableNames()) {
      if (name === bare(table)) {
        continue;
      }
      const keys = await this.probe(`PRAGMA foreign_key_list(${quote(name)})`).catch(() => []);
      for (const key of keys) {
        if (String(key['table']) !== bare(table)) {
          continue;
        }

        const action = actionOf(String(key['on_delete'] ?? ''));
        const child = quote(String(key['from']));
        const parent = quote(String(key['to'] ?? (await this.primaryKeyColumns(table))[0] ?? 'rowid'));

        const count = await this.countRows(
          name,
          `${child} IN (SELECT ${parent} FROM ${quote(table)} WHERE ${where})`,
          params,
        ).catch(() => 0);

        if (count > 0) {
          children.push({
            table: name,
            rows: count,
            via: { constraint: `${name}_fk`, action },
            children: [],
          });
        }
      }
    }

    if (children.length === 0) {
      return { ...root, children };
    }

    return {
      ...root,
      children,
      truncated:
        'Counted as though foreign keys are enforced. PRAGMA foreign_keys is per ' +
        'connection and off by default in SQLite, so whether these rows are really ' +
        'deleted depends on the connection your application uses \u2014 with it off, ' +
        'they stay behind as orphans instead.',
    };
  }

  /**
   * Applying, which happens in `commit.ts` and nowhere else.
   *
   * That file is the only one in the project allowed to write the word, and
   * exempting a second one would turn the rule into a habit. This hands it the
   * four operations it needs and keeps the driver on this side of the line.
   */
  async runCommitted(
    statements: readonly { sql: string; params: readonly unknown[] }[],
  ): Promise<{ applied: number; rowCounts: readonly (number | null)[] }> {
    const db = this.require();
    return runCommittedOnSqlite(
      {
        exec: (sql) => db.exec(sql),
        run: (sql, params) => this.run(sql, params, true),
      },
      statements,
    );
  }

  /**
   * `EXPLAIN QUERY PLAN`, which is a different thing from Postgres's `EXPLAIN`.
   *
   * It reports which index each step uses and nothing about cost or rows —
   * SQLite's planner has no cost model to report. So there is no number to
   * compare, and the only question it can answer is the one that matters most:
   * did it reach for the index or scan the table.
   */
  async explain(sql: string, _analyze: boolean, params: readonly unknown[] = []): Promise<QueryPlan> {
    return { raw: await this.probe(`EXPLAIN QUERY PLAN ${sql}`, params) };
  }

  async triggers(table: string): Promise<TriggerInfo[]> {
    const rows = await this.probe(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`,
      [bare(table)],
    );

    return rows.map((row) => {
      const sql = String(row['sql'] ?? '');
      return {
        name: String(row['name']),
        table: bare(table),
        timing: /instead\s+of/i.test(sql) ? 'instead of' : /\bbefore\b/i.test(sql) ? 'before' : 'after',
        events: ['insert', 'update', 'delete'].filter((event) =>
          new RegExp(`\\b${event}\\b`, 'i').test(sql.split(/\bON\b/i)[0] ?? ''),
        ),
        functionName: String(row['name']),
        enabled: true,
        // A SQLite trigger is SQL and nothing else — there is no procedural
        // language, no notification channel, and no way to reach a network. It
        // is the one engine here where a rollback really does take everything
        // back, and that is worth stating rather than leaving as an empty list
        // that looks like an unfinished check.
        escapes: [],
      };
    });
  }

  /**
   * What can be said about the health of a SQLite schema, which is less than
   * elsewhere and is said rather than padded.
   *
   * There are no index usage counters, so "this index is never used" is a
   * question with no answer here — reported as an empty list, with the reason
   * carried in `statsSince` being null. Redundant indexes and unindexed foreign
   * keys are structural, and those are answered properly.
   */
  async schemaHealth(): Promise<SchemaHealth> {
    const names = await this.tableNames();
    const tables = [];
    const redundant = [];
    const unindexed: UnindexedForeignKey[] = [];

    for (const name of names) {
      const stats = await this.tableStats(name).catch(() => ({ estimatedRows: 0, totalBytes: 0 }));
      tables.push({
        table: name,
        liveRows: stats.estimatedRows,
        deadRows: 0,
        modifiedSinceAnalyze: 0,
        lastVacuum: null,
        lastAnalyze: null,
        bytes: stats.totalBytes,
      });

      const indexes = await this.indexesOf(name);
      for (const index of indexes) {
        const covering = indexes.find(
          (other) =>
            other.name !== index.name &&
            other.columns.length > index.columns.length &&
            index.columns.every((column, position) => other.columns[position] === column),
        );
        if (covering && !index.unique && !index.primary) {
          redundant.push({ table: name, index: index.name, coveredBy: covering.name, bytes: 0 });
        }
      }

      for (const key of await this.foreignKeys([name])) {
        if (key.fromTable !== name) {
          continue;
        }
        const covered = indexes.some((index) =>
          key.fromColumns.every((column, position) => index.columns[position] === column),
        );
        if (!covered) {
          unindexed.push({
            constraint: key.name,
            table: name,
            columns: key.fromColumns,
            referencedTable: key.toTable,
            rows: stats.estimatedRows,
          });
        }
      }
    }

    return {
      // Null, and meant literally: SQLite keeps no statistics, so there is no
      // window these numbers were measured over.
      statsSince: null,
      unusedIndexes: [],
      redundantIndexes: redundant,
      unindexedForeignKeys: unindexed,
      tables,
    };
  }

  /** No. SQLite has no equivalent of hypopg, and no cost model to fool. */
  async supportsHypotheticalIndexes(): Promise<boolean> {
    return false;
  }

  /**
   * Builds the index for real inside a rolled-back transaction.
   *
   * The only method available here, and the good news is that it is cheap: the
   * database is a file on this machine, the build is not competing with
   * traffic, and the rollback really does remove it. What it cannot report is a
   * cost, because SQLite's `EXPLAIN QUERY PLAN` has none — so `used` is decided
   * by whether the plan names the index, which is the question anyone actually
   * asked.
   */
  async testIndex(
    indexSql: string,
    query: string,
    params: readonly unknown[],
    options: { readonly build: boolean },
  ): Promise<IndexExperiment> {
    if (!options.build) {
      throw new HypotheticalIndexUnavailableError();
    }

    return this.withRollback(async (tx) => {
      const beforeStarted = Date.now();
      const before = (await tx.query(`EXPLAIN QUERY PLAN ${query}`, params)).rows;
      const beforeMs = Date.now() - beforeStarted;

      await tx.query(indexSql);

      const afterStarted = Date.now();
      const after = (await tx.query(`EXPLAIN QUERY PLAN ${query}`, params)).rows;
      const afterMs = Date.now() - afterStarted;

      const name = /(?:INDEX|index)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z0-9_]+)/.exec(indexSql)?.[1];
      const detail = after.map((row) => String(row['detail'] ?? '')).join(' ');

      return {
        method: 'built' as const,
        before: { raw: before },
        after: { raw: after },
        used: name ? detail.includes(name) : /USING\s+INDEX/i.test(detail),
        // SQLite's planner reports no cost. Zero here is not a measurement and
        // the note says so rather than letting two zeroes read as "no change".
        beforeCost: 0,
        afterCost: 0,
        beforeMs,
        afterMs,
        note:
          'SQLite reports no plan cost, so the comparison is whether the planner ' +
          'reaches for the index rather than by how much it is cheaper. The index ' +
          'was really built and really rolled back.',
      };
    });
  }

  // ---- internals -----------------------------------------------------------

  private require(): SqliteDatabase {
    if (!this.db) {
      throw new Error(`Not connected to ${this.file || 'a SQLite database'}.`);
    }
    return this.db;
  }

  /** A read, outside any transaction. */
  private async probe(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return (await this.run(sql, params, false)).rows;
  }

  private async run(
    sql: string,
    params: readonly unknown[] = [],
    screen = true,
  ): Promise<QueryResult> {
    const db = this.require();

    // The same refusal every adapter here makes. The statements reaching this
    // come out of migration files, and a file containing a literal `COMMIT;`
    // would otherwise persist everything the preview just did.
    if (screen) {
      const control = CONTROL.exec(stripLeadingComments(sql));
      if (control) {
        throw new TransactionControlError(control[1]!);
      }
    }

    const positional = toPositional(sql, params);
    const statement = db.prepare(positional.sql);
    const bound = positional.params.map(bind);

    // `all` works for anything that returns rows and throws for anything that
    // does not, which is how the driver distinguishes them.
    try {
      const rows = statement.all(...bound);
      return { rows, rowCount: rows.length };
    } catch (error) {
      if (!/does not return data|run\(\)/i.test(messageOf(error))) {
        throw error;
      }
      const result = statement.run(...bound);
      return { rows: [], rowCount: Number(result.changes) };
    }
  }

  private async tableNames(): Promise<string[]> {
    const rows = await this.probe(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    );
    return rows.map((row) => String(row['name']));
  }

  private async indexesOf(table: string): Promise<IndexInfo[]> {
    const list = await this.probe(`PRAGMA index_list(${quote(table)})`).catch(() => []);
    const definitions = new Map(
      (
        await this.probe(
          `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
          [bare(table)],
        ).catch(() => [])
      ).map((row) => [String(row['name']), String(row['sql'] ?? '')]),
    );

    const indexes: IndexInfo[] = [];
    for (const row of list) {
      const name = String(row['name']);
      const info = await this.probe(`PRAGMA index_info(${quote(name)})`).catch(() => []);
      indexes.push({
        name,
        columns: info.map((column) => String(column['name'])),
        unique: Number(row['unique'] ?? 0) === 1,
        // `pk` is how SQLite marks the index behind a primary key.
        primary: String(row['origin'] ?? '') === 'pk',
        definition: definitions.get(name) ?? `INDEX ${name} ON ${bare(table)}`,
      });
    }

    return indexes;
  }

  /**
   * Constraints, read out of the stored `CREATE TABLE` text.
   *
   * SQLite has no constraint catalog: the schema is the statement that made it.
   * So the checks and the primary key are found in the text, which is exact for
   * what it finds and does not pretend to be a parser.
   */
  private async constraintsOf(table: string): Promise<ConstraintInfo[]> {
    const rows = await this.probe(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [bare(table)],
    );
    const sql = String(rows[0]?.['sql'] ?? '');
    const constraints: ConstraintInfo[] = [];

    for (const match of sql.matchAll(/\bCHECK\s*\(/gi)) {
      const expression = balanced(sql, match.index + match[0].length - 1);
      if (expression) {
        constraints.push({
          name: `check_${constraints.length + 1}`,
          type: 'check',
          definition: `CHECK ${expression}`,
        });
      }
    }

    const primary = await this.primaryKeyColumns(table);
    if (primary.length > 0) {
      constraints.push({
        name: `${bare(table)}_pk`,
        type: 'primary key',
        definition: `PRIMARY KEY (${primary.join(', ')})`,
      });
    }

    for (const key of await this.foreignKeys([bare(table)])) {
      if (key.fromTable !== bare(table)) {
        continue;
      }
      constraints.push({
        name: key.name,
        type: 'foreign key',
        definition:
          `FOREIGN KEY (${key.fromColumns.join(', ')}) ` +
          `REFERENCES ${key.toTable} (${key.toColumns.join(', ')})`,
      });
    }

    return constraints;
  }
}

/**
 * The file behind a connection string.
 *
 * `sqlite:./app.db`, `file:app.db`, and a bare path all name the same thing,
 * and people write all three.
 */
export function fileFrom(connectionString: string): string {
  const trimmed = connectionString.trim();
  const withoutScheme = trimmed.replace(/^(sqlite3?|file):(\/\/)?/i, '');
  const withoutQuery = withoutScheme.split('?')[0] ?? withoutScheme;
  return withoutQuery.length > 0 ? withoutQuery : ':memory:';
}

/**
 * `$1` in, `?` out.
 *
 * The analysis layer writes its predicates with Postgres's numbered
 * placeholders, because that is the engine it was written against, and every
 * other adapter has had to meet it there. SQLite reads `$1` as a *named*
 * parameter, which cannot be bound positionally — so the first statement with
 * a bound value failed with "column index out of range", which reads like a
 * bug in the query rather than a difference in dialect.
 *
 * Quoted text is stepped over rather than pattern-matched around: a literal
 * containing `$1` is a value, not a placeholder, and rewriting it would change
 * what the statement means.
 */
export function toPositional(
  sql: string,
  params: readonly unknown[],
): { sql: string; params: readonly unknown[] } {
  if (!/[$][0-9]/.test(sql)) {
    return { sql, params };
  }

  let out = '';
  const ordered: unknown[] = [];
  let i = 0;

  while (i < sql.length) {
    const char = sql[i]!;

    // Anything quoted or commented travels through untouched.
    const closer =
      char === "'" ? "'" : char === '"' ? '"' : char === '`' ? '`' : undefined;
    if (closer) {
      const end = sql.indexOf(closer, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf(String.fromCharCode(10), i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    const placeholder = /^[$]([0-9]+)/.exec(sql.slice(i));
    if (placeholder) {
      ordered.push(params[Number(placeholder[1]) - 1]);
      out += '?';
      i += placeholder[0].length;
      continue;
    }

    out += char;
    i += 1;
  }

  return { sql: out, params: ordered };
}

/** Which of SQLite's five affinities a declared type maps to, if any. */
function affinityOf(type: string): 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB' | undefined {
  const upper = type.toUpperCase();
  if (upper.includes('INT')) {
    return 'INTEGER';
  }
  if (/CHAR|CLOB|TEXT/.test(upper)) {
    return 'TEXT';
  }
  if (upper.includes('BLOB')) {
    return 'BLOB';
  }
  if (/REAL|FLOA|DOUB/.test(upper)) {
    return 'REAL';
  }
  if (/NUM|DEC|BOOL|DATE|TIME/.test(upper)) {
    return 'NUMERIC';
  }
  return undefined;
}

function actionOf(action: string): CascadeAction {
  switch (action.toUpperCase().trim()) {
    case 'CASCADE':
      return 'cascade';
    case 'SET NULL':
      return 'set null';
    case 'SET DEFAULT':
      return 'set default';
    case 'RESTRICT':
      return 'restrict';
    default:
      return 'no action';
  }
}

/** SQLite takes only these; a Date or a boolean has to be spelled out. */
function bind(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return String(value);
}

function quote(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.trim().replace(/^["'[`]|["'\]`]$/g, '').replace(/"/g, '""')}"`)
    .join('.');
}

function bare(name: string): string {
  const parts = name.split('.');
  return (parts[parts.length - 1] ?? name).replace(/^["'[`]|["'\]`]$/g, '');
}

function bareName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid savepoint name: ${name}`);
  }
  return name;
}

/** From an opening parenthesis to its match, inclusive. */
function balanced(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') {
      depth += 1;
    } else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open, i + 1);
      }
    }
  }
  return undefined;
}

function stripLeadingComments(sql: string): string {
  return sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
