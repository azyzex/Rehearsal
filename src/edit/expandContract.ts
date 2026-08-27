import { ColumnInfo, DatabaseAdapter } from '../adapters/types';
import { Edit, quoteIdentifier, quoteQualified } from './changeset';

/**
 * The same change, spread across deploys so it is never breaking.
 *
 * A migration and the code that uses it are never deployed at the same
 * instant. For a few seconds — or a few minutes, on a rolling deploy — the old
 * code is running against the new schema, or the new code against the old one.
 * Every column rename that has ever taken a site down took it down in that
 * window.
 *
 * The way out is old and well known and almost nobody writes it out: expand,
 * then contract. Add the new thing, fill it, write to both, move the readers,
 * stop writing the old one, and only then remove it. Each step is compatible
 * with the code on either side of it, so there is no window at all.
 *
 * It is not written out because it is tedious rather than difficult: six steps,
 * four of them one line, and the types and defaults have to be exactly right or
 * the fifth one fails. That is the kind of thing a tool connected to the live
 * schema can do properly — the column's real type comes from the database, not
 * from whatever the migration file remembers.
 *
 * ---
 *
 * Every plan here is Postgres, and it is deliberately opinionated in two
 * places:
 *
 * **The trigger.** Dual-writing can be done in the application, and the
 * application is where it belongs; it is also the step people skip, because it
 * means shipping code whose only purpose is to be deleted next week. The
 * trigger does it in one place and comes out in the same step that removes the
 * old column, so it cannot be forgotten separately.
 *
 * **The backfill is batched.** A one-line `UPDATE` over a large table takes a
 * row lock on every row it touches for the length of the statement, which is
 * the outage this whole plan exists to avoid.
 */

export interface PlanStep {
  /** "Deploy 1", "Deploy 2" — steps sharing a number can ship together. */
  readonly deploy: number;
  readonly title: string;
  /** Why this step exists, and what breaks without it. */
  readonly why: string;
  /** SQL for this step. Empty for a step that is application code. */
  readonly statements: readonly string[];
  /** Set when the step is a code change rather than a migration. */
  readonly code?: string;
}

export interface Plan {
  /** What is being made safe, in one line. */
  readonly what: string;
  readonly steps: readonly PlanStep[];
}

/**
 * Plans for the edits that need one.
 *
 * An edit with no plan is left alone rather than wrapped in ceremony: adding a
 * nullable column is already safe in one step, and dressing it up as a
 * six-deploy procedure would teach people to ignore the ones that matter.
 */
export async function expandContractPlans(
  adapter: DatabaseAdapter,
  edits: readonly Edit[],
): Promise<Plan[]> {
  const plans: Plan[] = [];

  for (const edit of edits) {
    const plan = await planFor(adapter, edit);
    if (plan) {
      plans.push(plan);
    }
  }

  return plans;
}

/** Whether anything in this changeset is worth spreading across deploys. */
export function needsPlan(edits: readonly Edit[]): boolean {
  return edits.some(
    (edit) =>
      edit.kind === 'drop_column' ||
      edit.kind === 'rename_column' ||
      edit.kind === 'alter_type' ||
      (edit.kind === 'set_nullability' && !edit.nullable),
  );
}

async function planFor(adapter: DatabaseAdapter, edit: Edit): Promise<Plan | undefined> {
  switch (edit.kind) {
    case 'drop_column':
      return dropColumnPlan(edit.table, edit.column);
    case 'rename_column':
      return renamePlan(adapter, edit.table, edit.column, edit.to);
    case 'alter_type':
      return retypePlan(adapter, edit.table, edit.column, edit.to, edit.using);
    case 'set_nullability':
      return edit.nullable ? undefined : notNullPlan(edit.table, edit.column);
    default:
      return undefined;
  }
}

/**
 * Dropping a column without breaking the code that still selects it.
 *
 * The dangerous part of a `DROP COLUMN` is not the statement — it is instant
 * and takes no scan. It is that `SELECT *` in the old code returns a row
 * without the field, and an ORM asked to hydrate it throws. So the column stops
 * being written first, stops being required second, and only then goes away.
 */
function dropColumnPlan(table: string, column: string): Plan {
  const relation = quoteQualified(table);
  const name = quoteIdentifier(column);

  return {
    what: `Dropping ${table}.${column}`,
    steps: [
      {
        deploy: 1,
        title: 'Stop using the column',
        why:
          `While any running copy of the application still reads or writes ` +
          `${column}, dropping it breaks that copy. This step ships no SQL at all.`,
        statements: [],
        code:
          `Remove every read and write of ${column}: the model field, any ` +
          `explicit SELECT list, any serialiser. Deploy it, and let it finish ` +
          `rolling out before the next step.`,
      },
      {
        deploy: 2,
        title: 'Make it optional',
        why:
          `Insurance for anything still inserting rows without it — a background ` +
          `job, an old worker, a copy of the app that has not restarted yet. ` +
          `Both statements are instant and take no scan.`,
        statements: [
          `ALTER TABLE ${relation} ALTER COLUMN ${name} DROP NOT NULL`,
          `ALTER TABLE ${relation} ALTER COLUMN ${name} DROP DEFAULT`,
        ],
      },
      {
        deploy: 3,
        title: 'Drop it',
        why:
          `Nothing reads it and nothing writes it. The statement itself is ` +
          `instant, and the data is gone for good — Dry Run's rescue file is the ` +
          `only copy you will have.`,
        statements: [`ALTER TABLE ${relation} DROP COLUMN ${name}`],
      },
    ],
  };
}

/**
 * A rename, which is the change people most often do in one step and most
 * often regret.
 *
 * `ALTER TABLE ... RENAME COLUMN` is instant and atomic, and that is exactly
 * the problem: the instant it commits, every running copy of the old code is
 * querying a column that no longer exists. There is no version of the
 * application that works with both names unless you make one.
 */
async function renamePlan(
  adapter: DatabaseAdapter,
  table: string,
  from: string,
  to: string,
): Promise<Plan> {
  const relation = quoteQualified(table);
  const oldName = quoteIdentifier(from);
  const newName = quoteIdentifier(to);
  const column = await columnOf(adapter, table, from);
  const type = column?.type ?? 'text';
  const trigger = handle(`${bare(table)}_${from}_to_${to}`);

  return {
    what: `Renaming ${table}.${from} to ${to}`,
    steps: [
      {
        deploy: 1,
        title: 'Add the new column, empty',
        why:
          `Nullable and without a default, so it is a catalog change and not a ` +
          `table rewrite. Nothing reads it yet.`,
        statements: [`ALTER TABLE ${relation} ADD COLUMN ${newName} ${type}`],
      },
      {
        deploy: 1,
        title: 'Keep both in step',
        why:
          `From here until the old column goes, a write to either has to land in ` +
          `both — otherwise the backfill races the traffic and loses. A trigger ` +
          `does this in one place, and comes out in the last step, so it cannot ` +
          `be left behind by accident.`,
        statements: [
          // TG_OP is checked rather than assumed: OLD does not exist in a
          // BEFORE INSERT trigger, and referring to it there is an error
          // rather than a null.
          `CREATE FUNCTION ${trigger}() RETURNS trigger AS $$\n` +
            `BEGIN\n` +
            `  IF TG_OP = 'INSERT' THEN\n` +
            `    IF NEW.${newName} IS NULL THEN\n` +
            `      NEW.${newName} := NEW.${oldName};\n` +
            `    ELSE\n` +
            `      NEW.${oldName} := NEW.${newName};\n` +
            `    END IF;\n` +
            `  ELSIF NEW.${newName} IS DISTINCT FROM OLD.${newName} THEN\n` +
            `    NEW.${oldName} := NEW.${newName};\n` +
            `  ELSE\n` +
            `    NEW.${newName} := NEW.${oldName};\n` +
            `  END IF;\n` +
            `  RETURN NEW;\n` +
            `END;\n` +
            `$$ LANGUAGE plpgsql`,
          `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON ${relation} ` +
            `FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        ],
      },
      {
        deploy: 2,
        title: 'Backfill the rows that already exist',
        why:
          `In batches. A single UPDATE over the whole table holds a row lock on ` +
          `every row it has touched until it commits, which is the outage this ` +
          `plan exists to avoid. Run it until it reports zero rows.`,
        statements: [
          `UPDATE ${relation} SET ${newName} = ${oldName}\n` +
            ` WHERE ${newName} IS NULL AND ${oldName} IS NOT NULL\n` +
            `   AND ctid IN (\n` +
            `     SELECT ctid FROM ${relation}\n` +
            `      WHERE ${newName} IS NULL AND ${oldName} IS NOT NULL\n` +
            `      LIMIT 5000\n` +
            `   )`,
        ],
      },
      {
        deploy: 3,
        title: 'Move the readers',
        why:
          `Both columns hold the same value now, and the trigger keeps it that ` +
          `way, so this deploy can go out at any pace. Nothing here is SQL.`,
        statements: [],
        code: `Change every read and write of ${from} to ${to}. Deploy, and let it finish rolling out.`,
      },
      {
        deploy: 4,
        title: 'Take the old column away',
        why:
          `The trigger goes in the same step as the column it was keeping in ` +
          `step. Leaving it behind would leave a trigger referring to a column ` +
          `that no longer exists, which fails on the next write.`,
        statements: [
          `DROP TRIGGER ${trigger} ON ${relation}`,
          `DROP FUNCTION ${trigger}()`,
          `ALTER TABLE ${relation} DROP COLUMN ${oldName}`,
        ],
      },
    ],
  };
}

/**
 * Changing a column's type without the rewrite that locks the table.
 *
 * `ALTER COLUMN ... TYPE` rewrites every row under ACCESS EXCLUSIVE — no reads,
 * no writes, for as long as the rewrite takes. The way around it is the same
 * shape as a rename: a new column of the new type, filled in the background.
 */
async function retypePlan(
  adapter: DatabaseAdapter,
  table: string,
  column: string,
  to: string,
  using?: string,
): Promise<Plan> {
  const relation = quoteQualified(table);
  const oldName = quoteIdentifier(column);
  const shadow = quoteIdentifier(`${column}_${bare(to).replace(/[^a-z0-9]+/gi, '_')}`);
  const current = await columnOf(adapter, table, column);
  const cast = using ? using : `${oldName}::${to}`;
  const trigger = handle(`${bare(table)}_${column}_retype`);

  return {
    what: `Changing ${table}.${column} from ${current?.type ?? 'its type'} to ${to}`,
    steps: [
      {
        deploy: 1,
        title: 'Add a column of the new type',
        why: `Nullable, so adding it is a catalog change rather than a rewrite.`,
        statements: [`ALTER TABLE ${relation} ADD COLUMN ${shadow} ${to}`],
      },
      {
        deploy: 1,
        title: 'Keep it filled as rows change',
        why:
          `Every insert and update from here fills both, so the backfill only ` +
          `ever has to deal with rows that existed when it started.`,
        statements: [
          `CREATE FUNCTION ${trigger}() RETURNS trigger AS $$\n` +
            `BEGIN\n` +
            `  NEW.${shadow} := ${cast.replace(new RegExp(escapeRegex(oldName), 'g'), `NEW.${oldName}`)};\n` +
            `  RETURN NEW;\n` +
            `END;\n` +
            `$$ LANGUAGE plpgsql`,
          `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON ${relation} ` +
            `FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        ],
      },
      {
        deploy: 2,
        title: 'Backfill in batches',
        why: `Run until it reports zero rows. Each batch is its own short transaction.`,
        statements: [
          `UPDATE ${relation} SET ${shadow} = ${cast}\n` +
            ` WHERE ${shadow} IS NULL AND ${oldName} IS NOT NULL\n` +
            `   AND ctid IN (\n` +
            `     SELECT ctid FROM ${relation}\n` +
            `      WHERE ${shadow} IS NULL AND ${oldName} IS NOT NULL\n` +
            `      LIMIT 5000\n` +
            `   )`,
        ],
      },
      {
        deploy: 3,
        title: 'Swap them',
        why:
          `Two renames inside one transaction: instant, atomic, and the only ` +
          `moment in this plan where the table is locked at all. Constraints, ` +
          `indexes and defaults on the old column do not travel with the rename ` +
          `— recreate them on the new column before this step.`,
        statements: [
          `DROP TRIGGER ${trigger} ON ${relation}`,
          `DROP FUNCTION ${trigger}()`,
          `ALTER TABLE ${relation} RENAME COLUMN ${oldName} TO ${quoteIdentifier(`${column}_old`)}`,
          `ALTER TABLE ${relation} RENAME COLUMN ${shadow} TO ${oldName}`,
        ],
      },
      {
        deploy: 4,
        title: 'Drop what is left',
        why: `Once a deploy has gone by with nobody complaining, the old column goes.`,
        statements: [
          `ALTER TABLE ${relation} DROP COLUMN ${quoteIdentifier(`${column}_old`)}`,
        ],
      },
    ],
  };
}

/**
 * `SET NOT NULL` in deploys, which is mostly about the writers.
 *
 * The lock problem has a pure-SQL answer — `rewrite.ts` offers it, and it is
 * the `CHECK ... NOT VALID` dance. What that does not solve is the writer that
 * is still inserting nulls: fix the rows, add the constraint, and the next
 * insert from the old code fails.
 */
function notNullPlan(table: string, column: string): Plan {
  const relation = quoteQualified(table);
  const name = quoteIdentifier(column);
  const constraint = quoteIdentifier(`${bare(table)}_${column}_not_null`);

  return {
    what: `Requiring ${table}.${column}`,
    steps: [
      {
        deploy: 1,
        title: 'Stop writing nulls',
        why:
          `The constraint will reject them the moment it exists. Backfilling ` +
          `first and deploying this later means the gap between the two fills up ` +
          `with new null rows.`,
        statements: [],
        code: `Make ${column} required in the application, and deploy that first.`,
      },
      {
        deploy: 2,
        title: 'Fill in the rows that have none',
        why:
          `In batches, and with a value you have decided on — there is no ` +
          `default that is right for every table.`,
        statements: [
          `UPDATE ${relation} SET ${name} = '' /* TODO: the right value */\n` +
            ` WHERE ${name} IS NULL\n` +
            `   AND ctid IN (SELECT ctid FROM ${relation} WHERE ${name} IS NULL LIMIT 5000)`,
        ],
      },
      {
        deploy: 3,
        title: 'Add the constraint without holding the table',
        why:
          `NOT VALID adds it without a scan, holding the lock for an instant. ` +
          `VALIDATE then scans under a lock writers can work alongside, and the ` +
          `final SET NOT NULL is free because the check already proves it.`,
        statements: [
          `ALTER TABLE ${relation} ADD CONSTRAINT ${constraint} CHECK (${name} IS NOT NULL) NOT VALID`,
          `ALTER TABLE ${relation} VALIDATE CONSTRAINT ${constraint}`,
          `ALTER TABLE ${relation} ALTER COLUMN ${name} SET NOT NULL`,
          `ALTER TABLE ${relation} DROP CONSTRAINT ${constraint}`,
        ],
      },
    ],
  };
}

/**
 * The plans as a file.
 *
 * One file rather than one per step, because the value is in seeing the whole
 * sequence at once — the steps are only meaningful in relation to each other,
 * and six tabs is not a plan. Each step says which deploy it belongs to, and
 * the banner between them is deliberately hard to run past by accident.
 */
export function renderPlans(plans: readonly Plan[]): string {
  const lines: string[] = [
    '-- Expand and contract: the same change, spread across deploys so that no',
    '-- step is ever incompatible with the code running beside it.',
    '--',
    '-- Steps marked with the same deploy number can ship together. Steps with',
    '-- different ones MUST NOT — the whole point is the gap between them, which',
    '-- is where the old code finishes rolling out.',
    '',
  ];

  for (const plan of plans) {
    lines.push(
      `-- ${'='.repeat(72)}`,
      `-- ${plan.what}`,
      `-- ${'='.repeat(72)}`,
      '',
    );

    for (const [index, step] of plan.steps.entries()) {
      lines.push(
        `-- Deploy ${step.deploy} — step ${index + 1} of ${plan.steps.length}: ${step.title}`,
      );
      for (const line of wrap(step.why, 74)) {
        lines.push(`--   ${line}`);
      }

      if (step.code) {
        lines.push('--');
        for (const line of wrap(`NO SQL. ${step.code}`, 74)) {
          lines.push(`--   ${line}`);
        }
      }

      lines.push('');
      for (const statement of step.statements) {
        lines.push(`${statement};`, '');
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

async function columnOf(
  adapter: DatabaseAdapter,
  table: string,
  column: string,
): Promise<ColumnInfo | undefined> {
  try {
    const columns = await adapter.tableColumns(table);
    return columns.find((candidate) => candidate.name === column);
  } catch {
    return undefined;
  }
}

function bare(name: string): string {
  const parts = name.split('.');
  return (parts[parts.length - 1] ?? name).replace(/"/g, '');
}

/**
 * A safe bare identifier for something this file creates.
 *
 * Trigger and function names are written unquoted, so they have to survive
 * being lowercased and stripped: a table called `Order Items` would otherwise
 * produce a name the server rejects on the step that matters most.
 */
function handle(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  // Postgres identifiers are truncated at 63 bytes; doing it here means the
  // CREATE and the DROP agree on the name rather than both being truncated
  // and hoping.
  return (cleaned.length > 0 ? cleaned : 'dryrun_sync').slice(0, 55);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line.length > 0) {
    lines.push(line);
  }

  return lines;
}
