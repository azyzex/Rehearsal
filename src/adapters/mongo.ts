import type { ClientSession, Db, Document, MongoClient } from 'mongodb';
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
  TriggerInfo,
} from './types';
import { MongoStatement, parseMongo } from '../parser/mongo';

/**
 * MongoDB adapter.
 *
 * Three databases, three different answers to the same question. Postgres rolls
 * DDL back like anything else. MySQL commits it silently, so the adapter has to
 * refuse it by hand. MongoDB refuses it itself — try to create an index inside
 * a transaction and the server says no — which means the rule this extension
 * needs is one the database already enforces.
 *
 * What MongoDB adds instead is a condition Postgres and MySQL do not have.
 * Multi-document transactions require a replica set: point this at a standalone
 * `mongod` and there is no rollback available at all, so a preview would apply
 * every change permanently while reporting them as previewed. So the adapter
 * checks on connect and refuses to work rather than silently becoming the thing
 * it exists to prevent.
 *
 * The other difference runs through everything below. MongoDB has no schema and
 * no foreign keys — a collection is whatever its documents happen to contain.
 * So the shape is sampled rather than read, and every relationship is a
 * measurement rather than a declaration: how many of this field's values are
 * actually present as an `_id` somewhere else. Both are labelled as inferences
 * wherever they surface, because they are.
 */

/** Thrown when the deployment cannot roll anything back. */
export class NoTransactionsError extends Error {
  constructor(reason: string) {
    super(
      `This MongoDB deployment cannot do multi-document transactions (${reason}), so ` +
        `Dry Run has no way to undo what a preview does. It will not run one: a preview ` +
        `that cannot be rolled back is just an apply with a reassuring name. ` +
        `Transactions need a replica set or a sharded cluster — Atlas provides one, and ` +
        `a local single-node replica set works too.`,
    );
    this.name = 'NoTransactionsError';
  }
}

/** How many documents to look at when inferring a collection's shape. */
const SAMPLE_FOR_SHAPE = 200;

export class MongoAdapter implements DatabaseAdapter {
  readonly engine = 'mongo' as const;
  /**
   * True in the sense that matters: a preview really runs inside a transaction
   * that is really aborted. Index and collection operations are refused by the
   * server rather than by this adapter, and are probed instead.
   */
  readonly supportsTransactionalDDL = false;

  private client: MongoClient | undefined;
  private db: Db | undefined;
  private config: ConnectionConfig | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  async connect(config: ConnectionConfig): Promise<void> {
    const { MongoClient: Client } = await import('mongodb');
    this.config = config;

    this.client = new Client(config.connectionString, {
      appName: config.applicationName,
      serverSelectionTimeoutMS: Math.min(config.statementTimeoutMs, 10_000),
      // The primary, and nothing else. Two reasons, either of which would be
      // enough: a transaction can only read from the primary — MongoDB rejects
      // any other preference outright — and a count taken from a secondary
      // describes a replica that is behind, which is a measurement of
      // something other than the database the migration will run against.
      readPreference: 'primary',
    });

    await this.client.connect();
    this.db = this.client.db(databaseFrom(config.connectionString) || undefined);

    await this.requireTransactions();
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.db = undefined;
    await client?.close().catch(() => undefined);
  }

  /**
   * Checks that a rollback is actually available.
   *
   * Asked on connect rather than on first preview, so someone pointed at a
   * standalone mongod finds out when they connect rather than when they are
   * looking at numbers they believe were rolled back.
   */
  private async requireTransactions(): Promise<void> {
    const admin = this.requireClient().db('admin');
    const info = (await admin.command({ hello: 1 })) as Document;

    const isReplicaSet = typeof info['setName'] === 'string';
    const isSharded = info['msg'] === 'isdbgrid';

    if (!isReplicaSet && !isSharded) {
      throw new NoTransactionsError('it is a standalone server, not a replica set');
    }
  }

  /**
   * Runs `fn` inside a transaction that is always aborted.
   *
   * The session is the transaction here rather than a connection, so it is
   * passed to every operation explicitly — a query that forgets it runs outside
   * the transaction and is not rolled back, which is why nothing below reaches
   * the driver except through `tx`.
   */
  async withRollback<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const client = this.requireClient();
      const db = this.requireDb();
      const session = client.startSession();
      const savepoints: string[] = [];

      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });

        const tx: Transaction = {
          query: async (statement: string, params?: readonly unknown[]): Promise<QueryResult> => {
            void params;
            return runStatement(db, statement, session);
          },

          // MongoDB has no savepoints. Rather than pretend, these record the
          // name and do nothing, and `dml.ts` gets its "undo just that
          // statement" from the surrounding abort instead. Silently accepting
          // a rollbackTo that did nothing would be worse, so an unknown name
          // is an error.
          savepoint: async (name: string): Promise<void> => {
            savepoints.push(name);
          },
          rollbackTo: async (name: string): Promise<void> => {
            if (!savepoints.includes(name)) {
              throw new Error(`No such savepoint: ${name}`);
            }
          },
        };

        return await fn(tx);
      } finally {
        // In a finally, so a thrown statement is aborted too.
        await session.abortTransaction().catch(() => undefined);
        await session.endSession().catch(() => undefined);
      }
    });
  }

  // ---- read-only probes ---------------------------------------------------

  async countRows(collection: string, where?: string): Promise<number> {
    return this.requireDb()
      .collection(collection)
      .countDocuments(filterOf(where), { maxTimeMS: this.timeout() });
  }

  async countNonNull(collection: string, field: string): Promise<number> {
    // Present and not null. In MongoDB a missing field and a null one are
    // different things, and both mean "no value here" for this question.
    return this.requireDb()
      .collection(collection)
      .countDocuments({ [field]: { $exists: true, $ne: null } }, { maxTimeMS: this.timeout() });
  }

  async countViolating(collection: string, predicate: string): Promise<number> {
    const filter = filterOf(predicate);
    return this.requireDb()
      .collection(collection)
      .countDocuments({ $nor: [filter] }, { maxTimeMS: this.timeout() });
  }

  /**
   * Documents whose reference points at nothing.
   *
   * MongoDB has no foreign keys, so this is the only way to ask: join the
   * field against the other collection's `_id` and count what did not match.
   */
  async countOrphans(
    collection: string,
    fields: readonly string[],
    referenced: string,
    referencedFields: readonly string[],
  ): Promise<number> {
    const local = fields[0]!;
    const foreign = referencedFields[0] ?? '_id';

    const result = await this.requireDb()
      .collection(collection)
      .aggregate(
        [
          { $match: { [local]: { $exists: true, $ne: null } } },
          {
            $lookup: {
              from: referenced,
              localField: local,
              foreignField: foreign,
              as: '__matched',
            },
          },
          { $match: { __matched: { $size: 0 } } },
          { $count: 'n' },
        ],
        { maxTimeMS: this.timeout() },
      )
      .toArray();

    return Number(result[0]?.['n'] ?? 0);
  }

  async countDuplicates(
    collection: string,
    fields: readonly string[],
  ): Promise<{ groups: number; rows: number }> {
    const key = Object.fromEntries(fields.map((field) => [field.replace(/\./g, '_'), `$${field}`]));
    const present = Object.fromEntries(
      fields.map((field) => [field, { $exists: true, $ne: null }]),
    );

    const result = await this.requireDb()
      .collection(collection)
      .aggregate(
        [
          { $match: present },
          { $group: { _id: key, n: { $sum: 1 } } },
          { $match: { n: { $gt: 1 } } },
          { $group: { _id: null, groups: { $sum: 1 }, rows: { $sum: '$n' } } },
        ],
        { maxTimeMS: this.timeout() },
      )
      .toArray();

    return {
      groups: Number(result[0]?.['groups'] ?? 0),
      rows: Number(result[0]?.['rows'] ?? 0),
    };
  }

  /**
   * Documents whose value would not survive the new type.
   *
   * MongoDB stores a type per value rather than per field, so this counts the
   * documents whose value is not already of the target type and cannot be
   * converted — which is the question, phrased the way this database allows.
   */
  async countCastFailures(
    collection: string,
    field: string,
    newType: string,
  ): Promise<number | null> {
    const target = bsonType(newType);
    if (!target) {
      return null;
    }

    try {
      const result = await this.requireDb()
        .collection(collection)
        .aggregate(
          [
            { $match: { [field]: { $exists: true, $ne: null } } },
            {
              $addFields: {
                __converted: {
                  $convert: { input: `$${field}`, to: target, onError: null, onNull: null },
                },
              },
            },
            { $match: { __converted: null } },
            { $count: 'n' },
          ],
          { maxTimeMS: this.timeout() },
        )
        .toArray();

      return Number(result[0]?.['n'] ?? 0);
    } catch {
      return null;
    }
  }

  async tableStats(collection: string): Promise<TableStats> {
    const stats = await this.collectionStats(collection);
    return {
      schema: this.requireDb().databaseName,
      table: collection,
      estimatedRows: stats.count,
      totalBytes: stats.bytes,
    };
  }

  async sampleRows(
    collection: string,
    pks: PrimaryKeyValue[],
    limit: number,
  ): Promise<Row[]> {
    if (pks.length === 0) {
      return [];
    }
    // The driver types `_id` as an ObjectId, and it is whatever the documents
    // put there — a string, a number, a compound key. Widened deliberately.
    const ids = pks.slice(0, limit).map((pk) => pk['_id']) as Document[];
    const documents = await this.requireDb()
      .collection(collection)
      .find({ _id: { $in: ids } } as Document, { limit, maxTimeMS: this.timeout() })
      .toArray();

    return documents.map((document) => flatten(document));
  }

  /** Always `_id`. Every document has one and nothing else is guaranteed unique. */
  async primaryKeyColumns(collection: string): Promise<string[]> {
    void collection;
    return ['_id'];
  }

  /**
   * The fields a collection appears to have.
   *
   * Sampled, not read: MongoDB has no schema, so this is the shape the
   * documents happen to be in. A field present in 3 of 200 sampled documents
   * is reported as nullable because for most documents it does not exist,
   * which is the same fact from the reader's point of view.
   */
  async tableColumns(collection: string): Promise<ColumnInfo[]> {
    const documents = await this.requireDb()
      .collection(collection)
      .aggregate([{ $sample: { size: SAMPLE_FOR_SHAPE } }], { maxTimeMS: this.timeout() })
      .toArray();

    const seen = new Map<string, { types: Set<string>; count: number }>();
    for (const document of documents) {
      for (const [field, value] of Object.entries(flatten(document))) {
        const entry = seen.get(field) ?? { types: new Set<string>(), count: 0 };
        entry.count += 1;
        entry.types.add(typeName(value));
        seen.set(field, entry);
      }
    }

    return [...seen.entries()]
      // `_id` first, then by how many documents carry the field: a field
      // every document has is more the shape of the collection than one a
      // handful do.
      .sort((a, b) =>
        a[0] === '_id' ? -1 : b[0] === '_id' ? 1 : b[1].count - a[1].count || a[0].localeCompare(b[0]),
      )
      .map(([name, entry]) => ({
        name,
        type: [...entry.types].sort().join(' | '),
        nullable: entry.count < documents.length,
        isPrimaryKey: name === '_id',
      }));
  }

  /**
   * Relationships, measured rather than declared.
   *
   * MongoDB has no foreign keys. What it has is fields named like references —
   * `user_id`, `userId`, `user` — whose values are very often the `_id` of
   * another collection. So the naming suggests a candidate and a count decides
   * it: a field whose values are overwhelmingly present in another collection
   * is a relationship, whatever the database thinks.
   */
  async foreignKeys(collections: readonly string[]): Promise<ForeignKeyInfo[]> {
    const names = new Set(collections.length > 0 ? collections : await this.collectionNames());
    const found: ForeignKeyInfo[] = [];

    for (const collection of names) {
      const columns = await this.tableColumns(collection);

      for (const column of columns) {
        const target = referenceTarget(column.name, [...names]);
        if (!target || target === collection) {
          continue;
        }

        const total = await this.countNonNull(collection, column.name);
        if (total === 0) {
          continue;
        }

        const orphans = await this.countOrphans(collection, [column.name], target, ['_id']);
        const matched = total - orphans;

        // Most of them have to line up. A field that matches a tenth of the
        // time shares a name with something and nothing else.
        if (matched / total >= 0.8) {
          found.push({
            name: `${collection}.${column.name} → ${target}._id (inferred)`,
            fromTable: collection,
            fromColumns: [column.name],
            toTable: target,
            toColumns: ['_id'],
          });
        }
      }
    }

    return found;
  }

  async schemaSnapshot(): Promise<SchemaSnapshot> {
    const names = await this.collectionNames();
    const database = this.requireDb().databaseName;

    const tables: SchemaTable[] = [];
    for (const name of names) {
      const stats = await this.collectionStats(name);
      tables.push({
        schema: database,
        name,
        qualified: name,
        rows: stats.count,
        bytes: stats.bytes,
        columns: await this.tableColumns(name),
        partitioned: false,
      });
    }

    return {
      tables,
      foreignKeys: await this.foreignKeys(names),
      schemas: [database],
    };
  }

  async tableDetail(
    collection: string,
    sampleLimit: number,
    filter?: string,
  ): Promise<TableDetail> {
    const columns = await this.tableColumns(collection);
    const rawIndexes = await this.requireDb().collection(collection).indexes();

    const indexes: IndexInfo[] = rawIndexes.map((index) => {
      const fields = Object.keys(index['key'] ?? {});
      return {
        name: String(index['name']),
        columns: fields,
        unique: Boolean(index['unique']),
        primary: fields.length === 1 && fields[0] === '_id',
        definition:
          `db.${collection}.createIndex(${JSON.stringify(index['key'])}` +
          `${index['unique'] ? ', { unique: true }' : ''})`,
      };
    });

    // The nearest thing MongoDB has to a constraint. Reported so the drawer
    // does not simply say "none" about a collection that has validation on it.
    const constraints: ConstraintInfo[] = [];
    const options = await this.collectionOptions(collection);
    if (options['validator']) {
      constraints.push({
        name: `${collection} validator`,
        type: 'check',
        definition: JSON.stringify(options['validator']),
      });
    }
    for (const index of indexes.filter((index) => index.unique && !index.primary)) {
      constraints.push({
        name: index.name,
        type: 'unique',
        definition: `unique (${index.columns.join(', ')})`,
      });
    }

    const search = filter && filter.trim().length > 0 ? textSearch(columns, filter) : {};
    const documents =
      sampleLimit > 0
        ? await this.requireDb()
            .collection(collection)
            .find(search, { limit: sampleLimit, maxTimeMS: this.timeout() })
            .toArray()
        : [];

    const stats = await this.collectionStats(collection);

    return {
      table: collection,
      columns,
      indexes,
      constraints,
      primaryKey: ['_id'],
      rows: stats.count,
      rowsEstimated: false,
      sample: documents.map((document) => flatten(document)),
      ...(filter ? { filter, matched: documents.length } : {}),
    };
  }

  async rowsMatching(
    collection: string,
    where: string,
    limit: number,
    orderBy?: string,
  ): Promise<Row[]> {
    const cursor = this.requireDb()
      .collection(collection)
      .find(filterOf(where), { limit, maxTimeMS: this.timeout() });

    if (orderBy && orderBy.trim().length > 0) {
      cursor.sort(sortOf(orderBy));
    }
    return (await cursor.toArray()).map((document) => flatten(document));
  }

  /**
   * Operations running right now.
   *
   * MongoDB does not queue behind a lock the way Postgres does — its
   * concurrency is document-level and largely optimistic — so this reports
   * long-running operations on the collection rather than lock holders. The
   * question it answers is the same one: is something already busy here.
   */
  async lockHolders(collection: string): Promise<LockHolder[]> {
    try {
      const admin = this.requireClient().db('admin');
      const result = (await admin.command({
        currentOp: 1,
        active: true,
        ns: `${this.requireDb().databaseName}.${collection}`,
      })) as Document;

      const operations = Array.isArray(result['inprog']) ? result['inprog'] : [];

      return operations
        .filter((operation: Document) => Number(operation['secs_running'] ?? 0) > 0)
        .map((operation: Document) => ({
          pid: Number(operation['opid'] ?? 0),
          state: String(operation['op'] ?? 'operation'),
          applicationName: String(operation['appName'] ?? ''),
          query: JSON.stringify(operation['command'] ?? {}).slice(0, 200),
          seconds: Number(operation['secs_running'] ?? 0),
          lockMode: String(operation['op'] ?? ''),
        }));
    } catch {
      // currentOp needs a privilege a read-only user may not have. Saying
      // nothing is honest; claiming the collection is quiet would not be.
      return [];
    }
  }

  /**
   * What a delete would take with it.
   *
   * Nothing, as far as the database is concerned: MongoDB has no cascading
   * deletes, so a delete removes exactly what it matches. The inferred
   * relationships are reported as children with their counts anyway, because
   * "these 40,000 documents will now point at nothing" is the same problem
   * arriving by a different route.
   */
  async cascadeImpact(collection: string, where: string): Promise<CascadeNode> {
    const rows = await this.countRows(collection, where);
    const names = await this.collectionNames();
    const keys = await this.foreignKeys(names);

    const children: CascadeNode[] = [];
    for (const key of keys.filter((key) => key.toTable === collection)) {
      const referencing = await this.countNonNull(key.fromTable, key.fromColumns[0]!);
      if (referencing > 0) {
        children.push({
          table: key.fromTable,
          rows: referencing,
          children: [],
          via: { constraint: key.name, action: 'no action' },
          truncated:
            'MongoDB does not cascade. These documents are not deleted — they are left ' +
            'pointing at something that is no longer there.',
        });
      }
    }

    return { table: collection, rows, children };
  }

  /** MongoDB has no triggers. Change streams are the nearest thing and are not this. */
  async triggers(collection: string): Promise<TriggerInfo[]> {
    void collection;
    return [];
  }

  async schemaHealth(): Promise<SchemaHealth> {
    const names = await this.collectionNames();
    const unusedIndexes: SchemaHealth['unusedIndexes'][number][] = [];
    const tables: SchemaHealth['tables'][number][] = [];

    for (const name of names) {
      const stats = await this.collectionStats(name);
      tables.push({
        table: name,
        liveRows: stats.count,
        deadRows: 0,
        modifiedSinceAnalyze: 0,
        lastVacuum: null,
        lastAnalyze: null,
        bytes: stats.bytes,
      });

      try {
        const usage = await this.requireDb()
          .collection(name)
          .aggregate([{ $indexStats: {} }], { maxTimeMS: this.timeout() })
          .toArray();

        for (const index of usage) {
          const accesses = Number((index['accesses'] as Document | undefined)?.['ops'] ?? 0);
          const fields = Object.keys((index['key'] as Document | undefined) ?? {});
          const isId = fields.length === 1 && fields[0] === '_id';

          if (accesses === 0 && !isId) {
            unusedIndexes.push({
              table: name,
              index: String(index['name']),
              scans: 0,
              bytes: 0,
              definition: `db.${name}.createIndex(${JSON.stringify(index['key'])})`,
            });
          }
        }
      } catch {
        // $indexStats needs a privilege, and is not worth failing the report.
      }
    }

    return {
      // $indexStats counts from the last server start and carries no timestamp.
      statsSince: null,
      unusedIndexes,
      redundantIndexes: [],
      // Every reference is inferred here, so "no index behind it" is a
      // different and much weaker claim than it is on a real foreign key.
      unindexedForeignKeys: [],
      tables,
    };
  }

  async supportsHypotheticalIndexes(): Promise<boolean> {
    return false;
  }

  async testIndex(): Promise<IndexExperiment> {
    // MongoDB refuses index creation inside a transaction itself, so there is
    // no equivalent of the Postgres fallback that builds one and rolls it back.
    throw new HypotheticalIndexUnavailableError();
  }

  async runCommitted(): Promise<{ applied: number; rowCounts: readonly (number | null)[] }> {
    throw new Error(
      'Dry Run does not apply MongoDB changes. Collection and index operations cannot ' +
        'run inside a transaction at all, so a changeset containing one could not be ' +
        'undone if a later step failed. Export it and run it with your migration tool.',
    );
  }

  async explain(statement: string): Promise<QueryPlan> {
    const parsed = parseMongo(statement);
    if ('unreadable' in parsed) {
      throw new Error(parsed.unreadable);
    }

    const filter = (parsed.args[0] ?? {}) as Document;
    const plan = await this.requireDb()
      .collection(parsed.collection)
      .find(filter)
      .explain('queryPlanner');

    return { raw: plan };
  }

  // ---- internals ----------------------------------------------------------

  private async collectionNames(): Promise<string[]> {
    const collections = await this.requireDb()
      .listCollections({ type: 'collection' }, { nameOnly: true })
      .toArray();

    return collections
      .map((collection) => String(collection['name']))
      // Collections MongoDB keeps for itself.
      .filter((name) => !name.startsWith('system.'))
      .sort();
  }

  private async collectionOptions(collection: string): Promise<Document> {
    const found = (await this.requireDb()
      .listCollections({ name: collection })
      .toArray()) as Document[];
    return (found[0]?.['options'] as Document | undefined) ?? {};
  }

  private async collectionStats(
    collection: string,
  ): Promise<{ count: number; bytes: number }> {
    try {
      const result = await this.requireDb()
        .collection(collection)
        .aggregate(
          [{ $collStats: { storageStats: {} } }],
          { maxTimeMS: this.timeout() },
        )
        .toArray();

      const storage = (result[0]?.['storageStats'] as Document | undefined) ?? {};
      return {
        count: Number(storage['count'] ?? 0),
        bytes: Number(storage['size'] ?? 0) + Number(storage['totalIndexSize'] ?? 0),
      };
    } catch {
      // $collStats can be unavailable. An exact count is slower and always
      // works, and being slow is better than being wrong about a size.
      return {
        count: await this.requireDb()
          .collection(collection)
          .countDocuments({}, { maxTimeMS: this.timeout() }),
        bytes: 0,
      };
    }
  }

  private timeout(): number {
    return this.config?.statementTimeoutMs ?? 10_000;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireClient(): MongoClient {
    if (!this.client) {
      throw new Error('Not connected.');
    }
    return this.client;
  }

  private requireDb(): Db {
    if (!this.db) {
      throw new Error('Not connected.');
    }
    return this.db;
  }
}

// ---- running one statement -------------------------------------------------

/**
 * Runs one parsed statement inside the session's transaction.
 *
 * Only the operations that change documents are here. Everything else was
 * classified as structure and never reaches a transaction, because MongoDB
 * would refuse it — which is the rule this extension wanted anyway.
 */
async function runStatement(
  db: Db,
  statement: string,
  session: ClientSession,
): Promise<QueryResult> {
  const parsed = parseMongo(statement);
  if ('unreadable' in parsed) {
    throw new Error(parsed.unreadable);
  }

  const collection = db.collection(parsed.collection);
  const [first, second] = parsed.args as [Document | undefined, Document | undefined];

  switch (parsed.operation) {
    case 'updateMany':
    case 'updateOne': {
      const result = await collection[parsed.operation === 'updateOne' ? 'updateOne' : 'updateMany'](
        first ?? {},
        second ?? {},
        { session },
      );
      return { rows: [], rowCount: result.modifiedCount };
    }

    case 'deleteMany':
    case 'deleteOne':
    case 'remove': {
      const result = await collection[parsed.operation === 'deleteOne' ? 'deleteOne' : 'deleteMany'](
        first ?? {},
        { session },
      );
      return { rows: [], rowCount: result.deletedCount };
    }

    case 'insertMany': {
      const documents = (parsed.args[0] as Document[] | undefined) ?? [];
      const result = await collection.insertMany(documents, { session });
      return { rows: [], rowCount: result.insertedCount };
    }

    case 'insertOne': {
      await collection.insertOne(first ?? {}, { session });
      return { rows: [], rowCount: 1 };
    }

    case 'countDocuments':
    case 'count': {
      const n = await collection.countDocuments(first ?? {}, { session });
      return { rows: [{ n }], rowCount: 1 };
    }

    case 'find': {
      const documents = await collection.find(first ?? {}, { session, limit: 100 }).toArray();
      return { rows: documents.map((document) => flatten(document)), rowCount: documents.length };
    }

    default:
      throw new Error(
        `${parsed.operation}() cannot run inside a transaction, so Dry Run will not ` +
          `run it. Its effects are measured by counting instead.`,
      );
  }
}

// ---- helpers ---------------------------------------------------------------

/** A filter written as JSON, or an empty one. */
export function filterOf(where?: string): Document {
  if (!where || where.trim().length === 0 || where.trim() === 'true' || where.trim() === '1 = 1') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(where);
    return parsed && typeof parsed === 'object' ? (parsed as Document) : {};
  } catch {
    throw new Error(
      `A MongoDB filter has to be JSON, and ${JSON.stringify(where.slice(0, 60))} is not.`,
    );
  }
}

/** `"field DESC"` or JSON, since callers write both. */
function sortOf(orderBy: string): Document {
  const trimmed = orderBy.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Document;
    }
  } catch {
    // Not JSON, so read it the SQL way below.
  }

  const match = /^["`']?([\w.]+)["`']?(?:\s+(ASC|DESC))?$/i.exec(trimmed);
  return match ? { [match[1]!]: /desc/i.test(match[2] ?? '') ? -1 : 1 } : {};
}

/**
 * A document as a flat row.
 *
 * Nested objects become `address.city`, which is how MongoDB itself addresses
 * them, so a field name in the panel is a field name you can query with.
 * Arrays are left whole: their length is the interesting thing and their
 * contents rarely fit a table cell.
 */
export function flatten(document: Document, prefix = ''): Row {
  const row: Row = {};

  for (const [key, value] of Object.entries(document)) {
    const name = prefix ? `${prefix}.${key}` : key;

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.constructor === Object
    ) {
      Object.assign(row, flatten(value as Document, name));
      continue;
    }
    row[name] = value;
  }
  return row;
}

/** What kind of thing a value is, in MongoDB's own vocabulary. */
function typeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value instanceof Date) {
    return 'date';
  }
  if (typeof value === 'object') {
    const name = (value as { _bsontype?: string })._bsontype;
    return name ? name.toLowerCase() : 'object';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'double';
  }
  return typeof value;
}

/**
 * The collection a field name points at, if any.
 *
 * `user_id`, `userId` and `user` all suggest `users`. Only a suggestion — the
 * caller decides by counting how many values actually match.
 */
export function referenceTarget(field: string, collections: readonly string[]): string | undefined {
  const stem = field
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_?(id|ids|_id)$/, '')
    .replace(/_+$/, '');

  if (stem.length === 0) {
    return undefined;
  }

  const candidates = [stem, `${stem}s`, `${stem}es`, stem.replace(/y$/, 'ies')];
  return collections.find((collection) => candidates.includes(collection.toLowerCase()));
}

/** The `$convert` target for a type someone named. */
function bsonType(newType: string): string | null {
  const type = newType.trim().toLowerCase();
  if (/^(string|text|varchar|char)/.test(type)) {
    return 'string';
  }
  if (/^(int|integer|smallint)/.test(type)) {
    return 'int';
  }
  if (/^(long|bigint)/.test(type)) {
    return 'long';
  }
  if (/^(double|float|real|decimal|numeric)/.test(type)) {
    return 'double';
  }
  if (/^(bool)/.test(type)) {
    return 'bool';
  }
  if (/^(date|timestamp)/.test(type)) {
    return 'date';
  }
  if (/^objectid$/.test(type)) {
    return 'objectId';
  }
  return null;
}

/** A case-insensitive match across every field, for finding one document. */
function textSearch(columns: readonly ColumnInfo[], filter: string): Document {
  const escaped = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    $or: columns.map((column) => ({ [column.name]: { $regex: escaped, $options: 'i' } })),
  };
}

/** The database named in a connection string, when it names one. */
function databaseFrom(connectionString: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(connectionString.trim());
  return match ? decodeURIComponent(match[1]!) : '';
}

export type { MongoStatement };
