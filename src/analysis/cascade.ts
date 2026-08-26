import { CascadeNode } from '../adapters/types';
import { formatCount, plural } from './severity';

/**
 * Reading a cascade.
 *
 * `DELETE FROM users WHERE id = 5` is one row in the statement and, with
 * `ON DELETE CASCADE`, an unknown number of rows across tables the statement
 * never mentions. The count is invisible in the SQL, invisible in the schema
 * diagram, and only obtainable by walking the foreign keys against the real
 * data — which is exactly the shape of question this tool exists to answer.
 *
 * `ON DELETE SET NULL` is included and reported separately, because it is the
 * quieter version of the same surprise: nothing is deleted, and a column full
 * of references silently becomes null.
 */

/** Every row the cascade removes, not counting the ones the statement names. */
export function cascadeTotal(node: CascadeNode | undefined): number {
  if (!node) {
    return 0;
  }
  return node.children.reduce((sum, child) => sum + child.rows + cascadeTotal(child), 0);
}

/** Tables the cascade reaches, in the order they are reached. */
export function cascadeTables(node: CascadeNode | undefined): string[] {
  if (!node) {
    return [];
  }
  const names: string[] = [];
  const walk = (current: CascadeNode): void => {
    for (const child of current.children) {
      if (!names.includes(child.table)) {
        names.push(child.table);
      }
      walk(child);
    }
  };
  walk(node);
  return names;
}

/**
 * Nodes whose rows really are deleted along with the parent.
 *
 * Only `ON DELETE CASCADE`. This used to be "everything that is not set null",
 * which quietly folded in the two actions that refuse the delete outright.
 */
export function deletedTables(node: CascadeNode | undefined): CascadeNode[] {
  const found: CascadeNode[] = [];
  const walk = (current: CascadeNode | undefined): void => {
    for (const child of current?.children ?? []) {
      if (child.via?.action === 'cascade') {
        found.push(child);
      }
      walk(child);
    }
  };
  walk(node);
  return found;
}


/**
 * Nodes whose reference refuses the delete rather than following it.
 *
 * `ON DELETE RESTRICT` and `NO ACTION` do not cascade and do not blank
 * anything: they make the statement fail. Counting them as "rows this also
 * deletes" was the wrong answer twice over — wrong about what happens, and
 * reassuring about a delete that will error.
 *
 * MongoDB reaches here too, because it has no cascade at all: the adapter
 * reports every reference as `no action` and explains, on the node, that the
 * documents are left pointing at something that is gone.
 */
export function blockingTables(node: CascadeNode | undefined): CascadeNode[] {
  const found: CascadeNode[] = [];
  const walk = (current: CascadeNode | undefined): void => {
    for (const child of current?.children ?? []) {
      if (child.via?.action === 'restrict' || child.via?.action === 'no action') {
        found.push(child);
      }
      walk(child);
    }
  };
  walk(node);
  return found;
}


/** Nodes whose rows are blanked rather than removed. */
export function nulledTables(node: CascadeNode | undefined): CascadeNode[] {
  const found: CascadeNode[] = [];
  const walk = (current: CascadeNode | undefined): void => {
    for (const child of current?.children ?? []) {
      if (child.via?.action === 'set null' || child.via?.action === 'set default') {
        found.push(child);
      }
      walk(child);
    }
  };
  walk(node);
  return found;
}

/**
 * The sentence appended to a delete's detail.
 *
 * Deliberately leads with the total across other tables, because that is the
 * number nobody expects. "1 row is deleted from users" followed by silence is
 * how people discover cascades in production.
 */
export function describeCascade(node: CascadeNode | undefined): string {
  if (!node) {
    return '';
  }

  // Three different things happen at the far end of a foreign key, and calling
  // all of them "cascades to" was wrong about two of them.
  const blanked = nulledTables(node);
  const blocking = blockingTables(node);
  const removed = deletedTables(node);
  const total = removed.reduce((sum, child) => sum + child.rows, 0);

  if (total === 0 && blanked.length === 0 && blocking.length === 0) {
    return '';
  }

  const parts: string[] = [];

  if (total > 0) {
    const tables = removed.length;
    parts.push(
      ` It also cascades to ${formatCount(total)} ${plural(total, 'row')} across ` +
        `${tables} other ${plural(tables, 'table')}: ` +
        `${removed.map((child) => `${formatCount(child.rows)} in ${child.table}`).join(', ')}.`,
    );
  }

  if (blocking.length > 0) {
    // Said early, because it is the part that changes what happens rather than
    // adding to it.
    const rows = blocking.reduce((sum, child) => sum + child.rows, 0);
    const note = blocking.find((child) => child.truncated)?.truncated;

    parts.push(
      ` ${blocking
        .map((child) => `${formatCount(child.rows)} ${plural(child.rows, 'row')} in ${child.table}`)
        .join(', ')} still ${rows === 1 ? 'references' : 'reference'} ` +
        `${rows === 1 ? 'it' : 'these'}.` +
        // The engine's own words when it has some — MongoDB explains that the
        // documents are orphaned rather than removed, which is more useful than
        // anything that could be said generically.
        (note ? ` ${note}` : ' The constraint does not cascade, so the delete is refused.'),
    );
  }

  if (blanked.length > 0) {
    parts.push(
      ` ${blanked
        .map((child) => `${formatCount(child.rows)} ${plural(child.rows, 'row')} in ${child.table}`)
        .join(', ')} ${
        blanked.length === 1 && blanked[0]!.rows === 1
          ? 'has its reference'
          : `${blanked.length === 1 ? 'has' : 'have'} their references`
      } set to null rather than being deleted.`,
    );
  }

  if (node.truncated) {
    parts.push(` The walk ${node.truncated}, so the real total may be higher.`);
  }

  return parts.join('');
}
