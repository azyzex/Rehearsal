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

  const removed = node.children.filter((child) => child.via?.action !== 'set null');
  const total = cascadeTotal(node);
  const blanked = nulledTables(node);

  if (total === 0 && blanked.length === 0) {
    return '';
  }

  const parts: string[] = [];

  if (total > 0) {
    const tables = cascadeTables(node).length;
    parts.push(
      ` It also cascades to ${formatCount(total)} ${plural(total, 'row')} across ` +
        `${tables} other ${plural(tables, 'table')}: ` +
        `${removed.map((child) => `${formatCount(child.rows)} in ${child.table}`).join(', ')}.`,
    );
  }

  if (blanked.length > 0) {
    parts.push(
      ` ${blanked
        .map((child) => `${formatCount(child.rows)} ${plural(child.rows, 'row')} in ${child.table}`)
        .join(', ')} ${blanked.length === 1 ? 'has' : 'have'} their reference set to null rather than being deleted.`,
    );
  }

  if (node.truncated) {
    parts.push(` The walk ${node.truncated}, so the real total may be higher.`);
  }

  return parts.join('');
}
