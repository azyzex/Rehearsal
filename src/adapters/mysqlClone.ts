import { Row } from './types';

/**
 * Measuring a MySQL schema change by running it, against a copy.
 *
 * MySQL commits DDL the moment it runs. There is no transaction to roll back,
 * so Dry Run refuses to execute an `ALTER` and measures its effect by counting
 * instead — how many rows hold a null, how many would not convert. That is a
 * good answer and it is an inference.
 *
 * This is the other way of getting one. Copy the table, run the real statement
 * against the copy, and report what MySQL actually did. The difference is not
 * small: the probe says "88 rows cannot convert", and the server says
 *
 *     Incorrect integer value: 'user21@example.com' for column 'email' at row 13
 *
 * — which names the value, and is the sentence someone can act on.
 *
 * ---
 *
 * It writes, which nothing else in this project does, so the rules around it
 * are strict and worth stating.
 *
 * **It never touches the original.** Every statement is rewritten to name the
 * copy, and a statement that cannot be rewritten with certainty is not run at
 * all. The copy carries a reserved prefix that the sweep below owns.
 *
 * **The copy is always dropped**, in a `finally`, and again by a sweep on the
 * next connection for anything a crash left behind. An orphaned copy of a
 * customer table is a real hazard — it is that customer's data, sitting under a
 * name nobody recognises.
 *
 * **It is off unless asked for.** Copying a table costs the disk the table
 * takes and the time to write it, and the answer it improves on is already a
 * good one.
 *
 * **It stops at a row ceiling.** Above it the copy costs more than the answer
 * is worth, and the count is what you get.
 *
 * ---
 *
 * One thing it cannot tell you, and the reason is worth knowing:
 * `CREATE TABLE … LIKE` copies columns and indexes but **not** foreign keys.
 * That solves the hard part of this technique for us — a copy cannot collide
 * with the original's constraints — and it means the copy has no foreign keys
 * to violate. So a statement whose failure would be a foreign key failure
 * succeeds here. The count is still the authority for those, and the result
 * says so rather than letting a green answer stand for something it did not
 * test.
 */

/** Reserved. Anything under this name belongs to Dry Run and is disposable. */
export const CLONE_PREFIX = '_dryrun_clone_';

/** Above this many rows, copying costs more than the better answer is worth. */
export const DEFAULT_ROW_CEILING = 500_000;

/** A copy older than this was left by a crash, not by a run in progress. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export interface CloneMeasurement {
  /** False when it did not run, with `skipped` saying why. */
  readonly ran: boolean;
  /** Why it did not run, in words meant for the panel. */
  readonly skipped?: string;
  /** Whether the statement succeeded against the copy. */
  readonly succeeded?: boolean;
  /** What MySQL said when it did not. The most useful line this produces. */
  readonly error?: string;
  /** Warnings MySQL raised even though the statement succeeded. */
  readonly warnings?: readonly string[];
  /** How long the statement took against this many rows. */
  readonly milliseconds?: number;
  /** Rows in the copy, which is what the timing above is for. */
  readonly rows?: number;
}

export interface CloneOptions {
  readonly rowCeiling?: number;
  /** Rows in the table, when the caller already knows. Saves a count. */
  readonly knownRows?: number;
}

/** The subset of the adapter this needs, so tests can hand it a fake. */
export interface CloneRunner {
  readonly engine: string;
  countRows(table: string): Promise<number>;
  /** Runs one statement and returns its rows. Used for DDL as well as reads. */
  cloneExec(sql: string): Promise<Row[]>;
}

/**
 * Whether this connection may create tables at all.
 *
 * Many people point an analysis tool at a read-only role, which is the right
 * instinct. Asking first turns "you do not have CREATE" from an error in the
 * middle of a preview into a sentence about why the count is the answer.
 */
export async function canClone(runner: CloneRunner): Promise<boolean> {
  try {
    const rows = await runner.cloneExec('SHOW GRANTS FOR CURRENT_USER()');
    const granted = rows
      .map((row) => String(Object.values(row)[0] ?? ''))
      .join(' ')
      .toUpperCase();

    // `ALL PRIVILEGES` covers it; otherwise both are needed, because a copy
    // that cannot be dropped is worse than one that was never made.
    if (granted.includes('ALL PRIVILEGES')) {
      return true;
    }
    return granted.includes('CREATE') && granted.includes('DROP');
  } catch {
    // Some managed providers refuse SHOW GRANTS. Assuming no is the safe
    // reading: it costs a better answer, and assuming yes costs a failed
    // statement in the middle of someone's preview.
    return false;
  }
}

/**
 * Runs one DDL statement against a copy of the table it names.
 *
 * The statement is rewritten to name the copy. If its table name cannot be
 * replaced with certainty the statement is not run — guessing here would mean
 * running an `ALTER` against the real table, which is the one outcome this
 * whole module exists to make impossible.
 */
export async function measureOnClone(
  runner: CloneRunner,
  table: string,
  statement: string,
  options: CloneOptions = {},
): Promise<CloneMeasurement> {
  if (runner.engine !== 'mysql') {
    return { ran: false, skipped: 'Copying a table to measure against is a MySQL technique.' };
  }

  const bare = bareName(table);
  if (bare.startsWith(CLONE_PREFIX)) {
    return { ran: false, skipped: 'That is already a Dry Run copy.' };
  }

  const rewritten = rewriteTarget(statement, bare);
  if (!rewritten) {
    return {
      ran: false,
      skipped:
        'Dry Run could not be certain which table that statement names, so it was not run ' +
        'against a copy. The count below is the answer.',
    };
  }

  const ceiling = options.rowCeiling ?? DEFAULT_ROW_CEILING;
  const rows = options.knownRows ?? (await runner.countRows(table));
  if (rows > ceiling) {
    return {
      ran: false,
      skipped:
        `${table} has ${rows.toLocaleString()} rows, over the ${ceiling.toLocaleString()} ` +
        `limit for copying one. The count below is the answer.`,
    };
  }

  const clone = cloneName(bare);
  let created = false;

  try {
    await runner.cloneExec(`CREATE TABLE ${quote(clone)} LIKE ${quote(bare)}`);
    created = true;
    await runner.cloneExec(`INSERT INTO ${quote(clone)} SELECT * FROM ${quote(bare)}`);

    const started = Date.now();
    try {
      await runner.cloneExec(rewritten(clone));
      const milliseconds = Date.now() - started;
      return {
        ran: true,
        succeeded: true,
        rows,
        milliseconds,
        warnings: (await warningsFrom(runner)).map((warning) => own(warning, clone, bare)),
      };
    } catch (error) {
      return {
        ran: true,
        succeeded: false,
        rows,
        milliseconds: Date.now() - started,
        error: own(messageOf(error), clone, bare),
      };
    }
  } catch (error) {
    // Failing to build the copy is not a finding about the statement. Say so,
    // and let the count stand.
    return {
      ran: false,
      skipped: `Dry Run could not copy ${table} to measure against: ${messageOf(error)}`,
    };
  } finally {
    if (created) {
      await runner.cloneExec(`DROP TABLE IF EXISTS ${quote(clone)}`).catch(() => undefined);
    }
  }
}

/**
 * Drops copies an earlier run left behind.
 *
 * Called on connect. Only names under the reserved prefix, and only those old
 * enough that no run in progress could own them — two windows previewing at
 * once must not delete each other's working copies.
 */
export async function sweepStaleClones(
  runner: CloneRunner,
  olderThanMs: number = STALE_AFTER_MS,
): Promise<string[]> {
  const dropped: string[] = [];

  try {
    const rows = await runner.cloneExec(
      `SELECT TABLE_NAME AS name, CREATE_TIME AS created
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME LIKE '${CLONE_PREFIX.replace(/_/g, '\\_')}%'`,
    );

    const cutoff = Date.now() - olderThanMs;
    for (const row of rows) {
      const name = String(row['name'] ?? '');
      const created = row['created'] ? new Date(String(row['created'])).getTime() : 0;

      if (!name.startsWith(CLONE_PREFIX)) {
        continue;
      }
      // An unknown creation time is treated as old: a copy nobody can date is
      // one nobody is using.
      if (created && created > cutoff) {
        continue;
      }

      await runner.cloneExec(`DROP TABLE IF EXISTS ${quote(name)}`);
      dropped.push(name);
    }
  } catch {
    // A sweep that cannot run is not worth failing a connection over. The
    // copies it would have dropped are inert.
  }

  return dropped;
}

/**
 * A function that puts the copy's name where the original's was, or nothing
 * when the statement's target cannot be identified beyond doubt.
 *
 * Deliberately narrow. It matches the shapes the classifier already recognises
 * and refuses everything else, because the cost of being clever here is running
 * a schema change against a real table.
 */
function rewriteTarget(statement: string, table: string): ((clone: string) => string) | undefined {
  const trimmed = statement.trim().replace(/;\s*$/, '');

  // `ALTER TABLE <name> …` and `CREATE INDEX … ON <name> …`, with the name
  // optionally quoted or schema-qualified.
  const name = `(?:\`[^\`]+\`|"[^"]+"|[A-Za-z0-9_$]+)`;
  const qualified = `(?:${name}\\s*\\.\\s*)?(${name})`;

  const alter = new RegExp(`^(ALTER\\s+TABLE\\s+)${qualified}(\\s)`, 'i').exec(trimmed);
  if (alter && unquote(alter[2]!) === table) {
    return (clone) =>
      trimmed.slice(0, alter.index) +
      alter[1] +
      quote(clone) +
      trimmed.slice(alter.index + alter[0].length - 1);
  }

  const onTable = new RegExp(`^(CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+.*?\\sON\\s+)${qualified}(\\s|\\()`, 'i').exec(
    trimmed,
  );
  if (onTable && unquote(onTable[2]!) === table) {
    return (clone) =>
      trimmed.slice(0, onTable.index) +
      onTable[1] +
      quote(clone) +
      trimmed.slice(onTable.index + onTable[0].length - 1);
  }

  return undefined;
}

/** MySQL's warnings for the last statement, which it raises instead of failing. */
async function warningsFrom(runner: CloneRunner): Promise<string[]> {
  try {
    const rows = await runner.cloneExec('SHOW WARNINGS');
    return rows
      .map((row) => String(row['Message'] ?? row['message'] ?? ''))
      .filter((message) => message.length > 0);
  } catch {
    return [];
  }
}

/**
 * A name no real table has and no two runs share.
 *
 * MySQL identifiers stop at 64 characters, so the original's name is trimmed
 * rather than the prefix or the unique part — a collision would mean two
 * previews dropping each other's copies.
 */
function cloneName(table: string): string {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const room = 64 - CLONE_PREFIX.length - unique.length - 1;
  return `${CLONE_PREFIX}${unique}_${table.slice(0, Math.max(room, 0))}`;
}

function bareName(table: string): string {
  const at = table.lastIndexOf('.');
  return unquote(at === -1 ? table : table.slice(at + 1));
}

function unquote(name: string): string {
  return name.trim().replace(/^[`"]|[`"]$/g, '');
}

function quote(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * Puts the real table's name back into what the server said.
 *
 * MySQL names the table it was actually working on, which is the copy:
 * "Duplicate entry 'a@b.com' for key '_dryrun_clone_m3x9_users.one_email'".
 * Showing that to someone means showing them a table that does not exist and
 * an implementation detail they never asked about, in the one sentence here
 * that is supposed to be the clearest.
 */
function own(message: string, clone: string, table: string): string {
  return message.split(clone).join(table);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
