import { DatabaseAdapter, Row } from '../adapters/types';
import { MongoClassification, parseMongo } from '../parser/mongo';
import { Sample, Thresholds } from './types';

/**
 * Running a MongoDB write, and undoing it.
 *
 * The SQL version of this leans on two things MongoDB does not have. It adds a
 * `RETURNING` clause to find out which rows the statement touched, and it takes
 * a savepoint so one statement can be undone while the transaction carries on.
 * Neither exists here, so the same question is answered differently: look at
 * the documents the filter matches *before* running, remember their keys, and
 * read the same keys back afterwards.
 *
 * That turns out to be closer to what anyone wanted anyway. The before and
 * after rows are the same documents by construction rather than by inference,
 * and there is no ambiguity about which ones a join brought in — because there
 * are no joins.
 */

export interface MongoDmlOutcome {
  readonly rowCount: number;
  readonly sample?: Sample;
}

/** How many documents to hold on to for the before-and-after table. */
const SAMPLE_CAP = 50;

export async function analyzeMongoDml(
  adapter: DatabaseAdapter,
  statement: string,
  classification: MongoClassification,
  thresholds: Thresholds,
): Promise<MongoDmlOutcome> {
  const parsed = parseMongo(statement);
  if ('unreadable' in parsed) {
    throw new Error(parsed.unreadable);
  }

  const collection = parsed.collection;
  const limit = Math.max(1, Math.min(thresholds.sampleSize, SAMPLE_CAP));

  return adapter.withRollback(async (tx) => {
    // An insert has nothing to look at beforehand: the documents do not exist
    // yet, and their keys are assigned by the server.
    const inserting = classification.kind === 'insert';

    const before = inserting
      ? []
      : await read(tx, collection, JSON.stringify(parsed.args[0] ?? {}), limit);

    const result = await tx.query(statement);
    const rowCount = result.rowCount ?? 0;

    if (inserting) {
      return { rowCount };
    }

    // The same documents, by key, so the two halves of the table are the same
    // rows rather than two samples that happen to overlap.
    const keys = before.map((row) => row['_id']);
    const after =
      keys.length > 0
        ? await read(tx, collection, JSON.stringify({ _id: { $in: keys } }), limit)
        : [];

    const afterByKey = new Map(after.map((row) => [String(row['_id']), row]));

    const rows = before.map((row) => {
      const key = String(row['_id']);
      const updated = afterByKey.get(key);

      return {
        key: { _id: row['_id'] },
        before: row,
        // A delete leaves nothing behind, and that is what an absent `after`
        // means everywhere else in the panel too.
        after: updated ?? null,
        changed: changedFields(row, updated),
      };
    });

    return {
      rowCount,
      sample: {
        rows,
        totalAffected: rowCount,
        changedInSample: rows.filter((row) => row.changed.length > 0).length,
      },
    };
  });
}

/** Documents matching a filter, inside the transaction. */
async function read(
  tx: { query(statement: string): Promise<{ rows: Row[] }> },
  collection: string,
  filter: string,
  limit: number,
): Promise<Row[]> {
  const result = await tx.query(`db.${collection}.find(${filter})`);
  return result.rows.slice(0, limit);
}

/**
 * Which fields actually changed.
 *
 * An update can match a document and change nothing in it — setting a field to
 * the value it already holds — and saying "40,000 rows changed" about that is
 * true of the statement and false about the data.
 */
function changedFields(before: Row, after: Row | undefined): string[] {
  if (!after) {
    return Object.keys(before);
  }

  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}
