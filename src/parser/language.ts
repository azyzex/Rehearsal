import { Engine } from '../adapters/types';
import { Classification, classify } from './classifier';
import { SplitStatement, splitStatements } from './splitter';
import { classifyMongo, splitMongo } from './mongo';

/**
 * How to read a migration, per engine.
 *
 * Two of the three databases take SQL and one does not, and until this existed
 * the pipeline simply assumed SQL everywhere — so the MongoDB adapter was an
 * adapter nothing could reach. This is the one seam where that assumption
 * lived, made explicit and answered per engine.
 *
 * Everything downstream keeps working unchanged, because a Mongo statement is
 * classified into the same vocabulary: an `updateMany` is an update, a `drop()`
 * is a drop_table, and a `$unset` across a collection is a drop_column. The
 * analysis has never needed to know which database it was talking to, and it
 * still does not.
 */

export interface StatementLanguage {
  /** Splits a file into statements, with the offsets the panel needs. */
  split(source: string): SplitStatement[];
  classify(statement: string): Classification;
  /** What to call a statement in a message the user reads. */
  readonly noun: string;
}

const SQL: StatementLanguage = {
  split: splitStatements,
  classify,
  noun: 'statement',
};

const MONGO: StatementLanguage = {
  split: (source) =>
    splitMongo(source).map((statement) => ({
      ...statement,
      // Lines are filled in by the caller, which has the document and can
      // count them properly. Zero here rather than a guess.
      startLine: lineOf(source, statement.startOffset),
      endLine: lineOf(source, statement.endOffset),
    })),
  classify: classifyMongo,
  noun: 'operation',
};

export function languageFor(engine: Engine): StatementLanguage {
  return engine === 'mongo' ? MONGO : SQL;
}

/** The 0-based line an offset falls on. */
function lineOf(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }
  return line;
}
