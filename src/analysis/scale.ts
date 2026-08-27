import { estimateIndexBuildSeconds, formatCount, formatDuration, plural } from './severity';
import { Finding } from './types';

/**
 * What these numbers mean against the database you actually deploy to.
 *
 * This is the honest answer to the loudest limitation in the whole project.
 * Every count here is exact — and exact about staging, which has forty thousand
 * rows where production has forty million. "Locks the table for 300ms" is a
 * true measurement and a dangerous one, because the number someone carries out
 * of the panel is 300ms and the number they get on the night is four minutes.
 *
 * The fix is not cleverness, it is arithmetic plus one fact the tool cannot
 * know: how big the real table is. So it is asked for, in a setting, and the
 * moment it is given every measurement gets a second sentence.
 *
 * Two things this is careful about:
 *
 * **An index build is not linear.** Doubling the rows does not double the
 * build. The estimate at production scale is recomputed from the same curve the
 * original estimate came from, rather than multiplied by the row ratio — which
 * would overstate a large table by a lot.
 *
 * **An empty table is the dangerous case, not the harmless one.** Pointed at a
 * dev database where the table has no rows, every probe answers zero and every
 * row is green. That is the one situation where the panel is confidently
 * useless, and it is worth saying so in the loudest terms available.
 */

/** Table name to the number of rows it holds in the database you deploy to. */
export type ProductionScale = Readonly<Record<string, number>>;

export function scaleNote(
  finding: Finding,
  tableRows: number | undefined,
  scale: ProductionScale | undefined,
): string | undefined {
  const table = finding.classification.table;
  if (!scale || !table) {
    return undefined;
  }

  const there = lookup(scale, table);
  if (there === undefined || there < 0) {
    return undefined;
  }

  const rows = `${formatCount(there)} ${plural(there, 'row')}`;

  // Nothing was measured against anything. Every count is zero, every row is
  // green, and none of it is about the database in the sentence.
  if (tableRows === undefined || tableRows === 0) {
    return (
      `${table} is empty here and holds ${rows} in production. Nothing measured ` +
      `against this database says anything about that one.`
    );
  }

  const factor = there / tableRows;

  if (factor < 2 && factor > 0.5) {
    return `${table} holds ${rows} in production, about the same as here, so these numbers carry over.`;
  }

  if (factor <= 0.5) {
    return `${table} holds ${rows} in production, fewer than here, so these numbers are an upper bound.`;
  }

  const scaled = `${table} holds ${rows} in production, ${formatFactor(factor)} this database.`;

  // An index build is the one thing here with a duration, and the duration is
  // what people carry out of the panel.
  if (finding.kind === 'create_index' && finding.classification.concurrently !== true) {
    const here = estimateIndexBuildSeconds(tableRows);
    const production = estimateIndexBuildSeconds(there);
    return (
      `${scaled} The build there is roughly ${formatDuration(production)} rather than ` +
      `${formatDuration(here)} — and writes are blocked for all of it.`
    );
  }

  // A row count scales proportionally, which is a guess about how the data is
  // distributed and is labelled as one.
  if (typeof finding.rowCount === 'number' && finding.rowCount > 0) {
    const projected = Math.round(finding.rowCount * factor);
    return (
      `${scaled} If the same share of rows is affected there, that is nearer ` +
      `${formatCount(projected)} ${plural(projected, 'row')} than ${formatCount(finding.rowCount)}.`
    );
  }

  return scaled;
}

/**
 * The row count for a table, however the setting spells its name.
 *
 * A user writing `users` should not have to know that the classifier saw
 * `public.users`, and someone who wrote `public.users` should not be ignored
 * because the statement said `users`.
 */
function lookup(scale: ProductionScale, table: string): number | undefined {
  const direct = scale[table] ?? scale[table.toLowerCase()];
  if (typeof direct === 'number') {
    return direct;
  }

  const wanted = bare(table).toLowerCase();
  for (const [name, rows] of Object.entries(scale)) {
    if (bare(name).toLowerCase() === wanted && typeof rows === 'number') {
      return rows;
    }
  }

  return undefined;
}

function bare(name: string): string {
  const parts = name.split('.');
  return (parts[parts.length - 1] ?? name).replace(/["`]/g, '');
}

/** `400×`, `2.5×` — enough precision to be useful, not enough to look measured. */
function formatFactor(factor: number): string {
  if (factor >= 100) {
    return `${Math.round(factor)}× the size of`;
  }
  if (factor >= 10) {
    return `${factor.toFixed(0)}× the size of`;
  }
  return `${factor.toFixed(1)}× the size of`;
}
