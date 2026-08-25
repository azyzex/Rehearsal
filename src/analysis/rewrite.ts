import { Classification } from '../parser/classifier';
import { Finding } from './types';

/**
 * Safer ways to say the same thing.
 *
 * Diagnosis without a cure is only half useful. Each of these is a real
 * Postgres pattern that most developers have never met, and each turns a
 * statement that locks a table for the length of a scan into one that does
 * not.
 *
 * A rewrite is offered, never applied. It changes the shape of a migration —
 * one statement becomes three, and two of them want to be in separate
 * transactions — so the user has to see it and decide. Every rewrite goes back
 * through the ordinary preview afterwards, because a suggestion this tool has
 * not measured is exactly the kind of confident advice it exists to replace.
 */

export interface Rewrite {
  /** Short label for the button. */
  readonly title: string;
  /** Why the original is a problem and this is not. */
  readonly rationale: string;
  /** The replacement, as one or more statements. */
  readonly statements: readonly string[];
  /**
   * True when the replacement cannot run inside a single transaction.
   * `CREATE INDEX CONCURRENTLY` is the common case and a common surprise.
   */
  readonly needsSeparateTransactions?: boolean;
}

/**
 * What could be offered instead of this statement.
 *
 * Driven by what was *measured*, not by the statement text. A `SET NOT NULL`
 * on a table with no nulls needs no rewrite at all — it will apply cleanly,
 * and suggesting a three-step dance for it would be the cargo-cult version of
 * the advice.
 */
export function rewritesFor(finding: Finding, engine = 'postgres'): Rewrite[] {
  const { classification } = finding;
  const rewrites: Rewrite[] = [];

  // Every rewrite below is Postgres syntax. Offering it for another engine
  // would be handing someone a statement that does not run, which is worse
  // than offering nothing: it costs them the attempt and the trust.
  if (engine !== 'postgres') {
    return rewrites;
  }

  switch (classification.kind) {
    case 'create_index':
      if (!classification.concurrently) {
        rewrites.push(concurrentIndex(finding));
      }
      break;

    case 'set_not_null':
      rewrites.push(...notNullRewrites(finding));
      break;

    case 'add_check':
      if (classification.checkPredicate) {
        rewrites.push(
          notValidThenValidate(finding, `CHECK (${classification.checkPredicate})`, 'check'),
        );
      }
      break;

    case 'add_foreign_key': {
      const reference = classification.references;
      if (reference && classification.columns?.length) {
        const clause =
          `FOREIGN KEY (${classification.columns.join(', ')}) ` +
          `REFERENCES ${reference.table}` +
          (reference.columns.length ? ` (${reference.columns.join(', ')})` : '');
        // Named after the columns, following Postgres's own convention. A name
        // derived only from the table would collide the moment a table gained
        // a second foreign key.
        rewrites.push(
          notValidThenValidate(finding, clause, `${classification.columns.join('_')}_fkey`),
        );
      }
      break;
    }

    case 'add_unique':
      if (classification.columns?.length) {
        rewrites.push(uniqueViaConcurrentIndex(finding));
      }
      break;

    default:
      break;
  }

  return rewrites;
}

function concurrentIndex(finding: Finding): Rewrite {
  const { classification } = finding;
  const columns = (classification.columns ?? []).join(', ');
  const name = `idx_${bare(classification.table ?? 'table')}_${(classification.columns ?? []).join('_')}`;

  return {
    title: 'Build it without locking',
    rationale:
      'A plain CREATE INDEX holds a lock that blocks every write for the whole ' +
      'build. CONCURRENTLY builds it in two passes and takes a weaker lock, so ' +
      'reads and writes keep working. It takes longer overall and cannot run ' +
      'inside a transaction — which is why most migration tools do not do it ' +
      'for you.',
    statements: [
      `CREATE INDEX CONCURRENTLY ${name} ON ${classification.table} (${columns})`,
    ],
    needsSeparateTransactions: true,
  };
}

/**
 * `SET NOT NULL` in the form that does not hold the table.
 *
 * Postgres will accept a `SET NOT NULL` without a full scan if a validated
 * `CHECK (col IS NOT NULL)` already proves it — and the validation step takes
 * only SHARE UPDATE EXCLUSIVE, which writers can work alongside. So the scan
 * still happens; it just stops blocking everyone while it does.
 */
function notNullRewrites(finding: Finding): Rewrite[] {
  const { classification } = finding;
  const table = classification.table ?? 'the table';
  const column = classification.column ?? 'the column';
  const nulls = finding.rowCount ?? 0;
  const constraint = `${bare(table)}_${column}_not_null`;

  const rewrites: Rewrite[] = [];

  // First, the thing that actually has to happen: there is no rewrite that
  // makes a NOT NULL apply over null rows.
  if (nulls > 0) {
    rewrites.push({
      title: `Backfill the ${nulls} null ${nulls === 1 ? 'row' : 'rows'} first`,
      rationale:
        `No rewrite can make this apply while ${nulls} ${nulls === 1 ? 'row has' : 'rows have'} ` +
        `no ${column}. Decide what they should be, then add the constraint. ` +
        `Replace the placeholder before running it.`,
      statements: [
        `UPDATE ${table} SET ${column} = '' /* TODO: the right value */ WHERE ${column} IS NULL`,
      ],
    });
  }

  rewrites.push({
    title: 'Add it without holding the table',
    rationale:
      'A plain SET NOT NULL scans every row while holding a lock that blocks ' +
      'reads as well as writes. Proving the same thing with a CHECK constraint ' +
      'first moves the scan into VALIDATE, which takes a weaker lock that ' +
      'writers can work alongside. The final SET NOT NULL is then instant, ' +
      'because the check already proves it.',
    statements: [
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} IS NOT NULL) NOT VALID`,
      `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
      `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`,
      `ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`,
    ],
    needsSeparateTransactions: true,
  });

  return rewrites;
}

/**
 * The general form: add the constraint unvalidated, then validate it.
 *
 * Adding a constraint normally scans the whole table under a strong lock.
 * `NOT VALID` skips the scan entirely and takes the lock only for an instant;
 * `VALIDATE CONSTRAINT` then does the scan under SHARE UPDATE EXCLUSIVE, which
 * does not block writes. The constraint is enforced on new rows from the
 * moment it is added, so nothing slips through in between.
 */
function notValidThenValidate(finding: Finding, clause: string, suffix: string): Rewrite {
  const table = finding.classification.table ?? 'the table';
  const constraint = `${bare(table)}_${suffix}`;
  const violations = finding.rowCount ?? 0;

  return {
    title: 'Add it without scanning under a lock',
    rationale:
      (violations > 0
        ? `This still fails on the ${violations} existing ${violations === 1 ? 'row' : 'rows'} ` +
          `that violate it — fix those first. Once they are fixed, this form is the safe one: `
        : '') +
      'NOT VALID adds the constraint without scanning, holding the lock only ' +
      'for an instant, and VALIDATE does the scan under a lock writers can ' +
      'work alongside. New rows are checked from the moment it is added, so ' +
      'nothing slips through the gap.',
    statements: [
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${clause} NOT VALID`,
      `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
    ],
  };
}

/**
 * A unique constraint without the index build blocking writes.
 *
 * `ADD CONSTRAINT ... UNIQUE` builds an index under ACCESS EXCLUSIVE. Building
 * the index concurrently first and then adopting it takes the strong lock only
 * for the instant it takes to attach.
 */
function uniqueViaConcurrentIndex(finding: Finding): Rewrite {
  const { classification } = finding;
  const table = classification.table ?? 'the table';
  const columns = (classification.columns ?? []).join(', ');
  const index = `uq_${bare(table)}_${(classification.columns ?? []).join('_')}`;
  const duplicates = finding.rowCount ?? 0;

  return {
    title: 'Build the index first, then adopt it',
    rationale:
      (duplicates > 0
        ? `This still fails while ${duplicates} rows share a value — resolve those first. Then: `
        : '') +
      'ADD CONSTRAINT UNIQUE builds its index while holding a lock that blocks ' +
      'everything. Building the index CONCURRENTLY first, then attaching it, ' +
      'takes the strong lock only for the moment of attachment.',
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY ${index} ON ${table} (${columns})`,
      `ALTER TABLE ${table} ADD CONSTRAINT ${index} UNIQUE USING INDEX ${index}`,
    ],
    needsSeparateTransactions: true,
  };
}

function bare(table: string): string {
  const parts = table.split('.');
  return (parts[parts.length - 1] ?? table).replace(/"/g, '');
}

/** True when a statement is worth offering an alternative for at all. */
export function hasRewrites(classification: Classification): boolean {
  return (
    (classification.kind === 'create_index' && !classification.concurrently) ||
    classification.kind === 'set_not_null' ||
    classification.kind === 'add_check' ||
    classification.kind === 'add_foreign_key' ||
    classification.kind === 'add_unique'
  );
}
