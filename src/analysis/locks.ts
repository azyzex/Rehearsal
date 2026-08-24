import { StatementKind } from '../parser/classifier';

/**
 * Which lock a statement takes, and what that costs everyone else.
 *
 * This is the half of the story the row counts do not tell. "40 seconds to
 * build the index" is true in isolation and misleading in practice: Postgres
 * lock requests are queued fairly, so a DDL statement waiting behind a
 * long-running reader does not merely wait — every query that arrives after it
 * queues behind the *waiting* DDL, including reads that would otherwise have
 * been fine. A routine ADD COLUMN has taken production down for twenty-three
 * minutes this way, and a constraint validation for four hours.
 *
 * So a preview that reports duration without reporting lock level, and lock
 * level without checking who is holding one right now, is reporting the easy
 * two thirds of the question.
 */

export type LockLevel =
  | 'ACCESS EXCLUSIVE'
  | 'SHARE ROW EXCLUSIVE'
  | 'SHARE'
  | 'SHARE UPDATE EXCLUSIVE'
  | 'ROW EXCLUSIVE'
  | 'ACCESS SHARE'
  | 'NONE';

export interface LockProfile {
  readonly level: LockLevel;
  /** What other sessions cannot do while it is held. */
  readonly blocks: string;
  /**
   * True when the lock is held only long enough to change catalog entries.
   * A brief ACCESS EXCLUSIVE is usually harmless — unless it has to queue.
   */
  readonly brief: boolean;
}

const ACCESS_EXCLUSIVE_BLOCKS = 'every read and write on the table';
const SHARE_BLOCKS = 'all writes; reads continue';
const SHARE_ROW_BLOCKS = 'writes on both tables; reads continue';
const CONCURRENT_BLOCKS = 'nothing — reads and writes continue';

/**
 * The lock a statement kind takes.
 *
 * `brief` is the distinction that matters most in practice. `DROP COLUMN` and
 * `SET NOT NULL` both take ACCESS EXCLUSIVE, but one edits a catalog row and
 * the other scans every row in the table while holding it.
 */
export function lockProfileFor(
  kind: StatementKind,
  options: { concurrently?: boolean } = {},
): LockProfile {
  switch (kind) {
    case 'create_index':
      return options.concurrently
        ? { level: 'SHARE UPDATE EXCLUSIVE', blocks: CONCURRENT_BLOCKS, brief: false }
        : { level: 'SHARE', blocks: SHARE_BLOCKS, brief: false };

    case 'add_foreign_key':
      // Both ends are locked, which is the part people forget: adding a key to
      // a small table can block writes on the large one it points at.
      return { level: 'SHARE ROW EXCLUSIVE', blocks: SHARE_ROW_BLOCKS, brief: false };

    // Held while the whole table is scanned or rewritten.
    case 'set_not_null':
    case 'alter_column_type':
    case 'add_check':
    case 'add_unique':
      return { level: 'ACCESS EXCLUSIVE', blocks: ACCESS_EXCLUSIVE_BLOCKS, brief: false };

    // Catalog-only: the lock is strong but held for an instant.
    case 'add_column':
    case 'drop_column':
    case 'drop_not_null':
    case 'rename_column':
    case 'rename_table':
      return { level: 'ACCESS EXCLUSIVE', blocks: ACCESS_EXCLUSIVE_BLOCKS, brief: true };

    case 'drop_table':
    case 'truncate':
      return { level: 'ACCESS EXCLUSIVE', blocks: ACCESS_EXCLUSIVE_BLOCKS, brief: true };

    case 'update':
    case 'delete':
    case 'insert':
      return { level: 'ROW EXCLUSIVE', blocks: 'nothing except conflicting row locks', brief: false };

    case 'select':
      return { level: 'ACCESS SHARE', blocks: 'nothing', brief: true };

    case 'create_table':
      return { level: 'NONE', blocks: 'nothing — the table does not exist yet', brief: true };

    default:
      return { level: 'NONE', blocks: 'nothing measurable', brief: true };
  }
}

/** A session already holding a lock on the table a statement is about to touch. */
export interface Blocker {
  readonly pid: number;
  /** `active`, `idle in transaction`, and so on. */
  readonly state: string;
  readonly applicationName: string;
  readonly query: string;
  /** How long it has been in that state. */
  readonly seconds: number;
  readonly lockMode: string;
}

export interface LockOutlook {
  readonly table: string;
  readonly blockers: readonly Blocker[];
}

/**
 * Whether a statement taking `profile` would have to wait for `blockers`.
 *
 * Only conflicting locks matter. A reader holding ACCESS SHARE does not delay
 * an INSERT, but it does delay anything taking ACCESS EXCLUSIVE — and that is
 * the case that turns a one-second migration into an outage.
 */
export function wouldQueue(profile: LockProfile, blockers: readonly Blocker[]): Blocker[] {
  if (profile.level === 'NONE' || profile.level === 'ACCESS SHARE') {
    return [];
  }

  return blockers.filter((blocker) => conflicts(profile.level, blocker.lockMode));
}

/**
 * Postgres's lock conflict table, for the levels this tool can request.
 *
 * Simplified deliberately: ACCESS EXCLUSIVE conflicts with everything, and the
 * weaker levels this tool takes conflict with the write locks. Getting this
 * subtly wrong in the permissive direction would be the worst outcome, so
 * anything unrecognised is treated as conflicting.
 */
function conflicts(wanted: LockLevel, held: string): boolean {
  const heldLevel = held.replace(/Lock$/, '').toUpperCase().replace(/([a-z])([A-Z])/g, '$1 $2');

  if (wanted === 'ACCESS EXCLUSIVE') {
    return true; // conflicts with every other lock mode, including ACCESS SHARE
  }

  // A plain read never blocks these.
  if (/ACCESS\s*SHARE/.test(heldLevel)) {
    return false;
  }

  if (wanted === 'SHARE UPDATE EXCLUSIVE') {
    // Concurrent index builds still wait for other schema changes and vacuums.
    return !/ROW\s*EXCLUSIVE$/.test(heldLevel) || /SHARE\s*ROW\s*EXCLUSIVE/.test(heldLevel);
  }

  return true;
}

export function describeBlocker(blocker: Blocker): string {
  const duration = formatDuration(blocker.seconds);
  const who = blocker.applicationName ? ` from ${blocker.applicationName}` : '';

  if (blocker.state === 'idle in transaction') {
    // The worst kind: it is not doing anything, and it is not letting go.
    return `an idle transaction${who} (pid ${blocker.pid}) has held its lock for ${duration}`;
  }
  return `a ${blocker.state} query${who} (pid ${blocker.pid}) has been running for ${duration}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)} seconds`;
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = (seconds / 3600).toFixed(1);
  return `${hours} hours`;
}
