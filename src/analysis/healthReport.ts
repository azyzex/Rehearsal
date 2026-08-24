import { SchemaHealth } from "../adapters/types";

/**
 * The schema health report, as markdown.
 *
 * Markdown rather than another panel, for three reasons. It can be pasted into
 * the pull request that adds the index. It survives being read by someone who
 * does not have this extension. And it diffs — running it again next month and
 * looking at what changed is a more useful artefact than a panel that only ever
 * shows the present.
 *
 * Pure: it takes a snapshot and returns text, so the wording is testable
 * without a database.
 */

export interface ReportOptions {
  readonly connection: string;
  /** Below this many rows a table is too small for any of this to matter. */
  readonly smallTable?: number;
  readonly now?: Date;
}

export function healthReport(
  health: SchemaHealth,
  options: ReportOptions,
): string {
  const small = options.smallTable ?? 1000;
  const now = options.now ?? new Date();

  const lines: string[] = [
    "# Schema health",
    "",
    `**Database:** ${options.connection}  `,
    `**Read:** ${now.toISOString()}  `,
    `**Statistics cover:** ${describeWindow(health, now)}`,
    "",
    windowCaveat(health, now),
    "",
  ];

  lines.push(...foreignKeySection(health, small));
  lines.push(...redundantSection(health));
  lines.push(...unusedSection(health, now));
  lines.push(...staleSection(health, small));

  if (
    health.unindexedForeignKeys.length === 0 &&
    health.redundantIndexes.length === 0 &&
    health.unusedIndexes.length === 0
  ) {
    lines.push(
      "Nothing found. No unindexed foreign keys, no redundant indexes, no unread ones.",
      "",
    );
  }

  lines.push(
    "---",
    "",
    "Every number here was read from the database, not inferred from the schema. ",
    "Nothing was changed to produce it.",
    "",
  );

  return lines.join("\n");
}

function describeWindow(health: SchemaHealth, now: Date): string {
  if (!health.statsSince) {
    return "unknown";
  }
  return `${health.statsSince.toISOString()} — ${describeAge(health.statsSince, now)}`;
}

/**
 * The caveat that decides whether the rest of the report is usable.
 *
 * On a database whose statistics were reset an hour ago, "this index has never
 * been scanned" means nothing at all — and a platform that suspends idle
 * computes resets them every time it wakes up.
 */
function windowCaveat(health: SchemaHealth, now: Date): string {
  if (!health.statsSince) {
    return (
      '> The statistics window could not be determined. Treat every "unread" ' +
      "finding below as unproven."
    );
  }

  const days = (now.getTime() - health.statsSince.getTime()) / 86_400_000;
  if (days < 7) {
    return (
      `> These statistics are only ${describeAge(health.statsSince, now)} old. That is not ` +
      "long enough to call an index unused — a report that runs weekly, or a month-end " +
      'job, has not happened yet. Read the "never scanned" section as a list of ' +
      "candidates to watch, not a list to drop."
    );
  }
  return `> Statistics have been accumulating for ${describeAge(health.statsSince, now)}.`;
}

function foreignKeySection(health: SchemaHealth, small: number): string[] {
  const worth = health.unindexedForeignKeys.filter((key) => key.rows >= small);
  if (worth.length === 0) {
    return [];
  }

  const lines = [
    "## Foreign keys with no index behind them",
    "",
    "Deleting a parent row makes the database look for children. With no index that " +
      "is a sequential scan of the child table, once per deleted row, while holding a " +
      "lock — which is why a delete that should be instant takes minutes.",
    "",
    "| Table | Columns | References | Rows | Fix |",
    "| --- | --- | --- | ---: | --- |",
  ];

  for (const key of worth) {
    const columns = key.columns.join(", ");
    const fix = `\`CREATE INDEX CONCURRENTLY ON ${key.table} (${columns});\``;
    lines.push(
      `| \`${key.table}\` | \`${columns}\` | \`${key.referencedTable}\` | ` +
        `${key.rows.toLocaleString()} | ${fix} |`,
    );
  }

  const skipped = health.unindexedForeignKeys.length - worth.length;
  lines.push("");
  if (skipped > 0) {
    lines.push(
      `${skipped} more ${skipped === 1 ? "is" : "are"} on tables under ` +
        `${small.toLocaleString()} rows, where a scan costs nothing worth indexing for.`,
      "",
    );
  }
  return lines;
}

function redundantSection(health: SchemaHealth): string[] {
  if (health.redundantIndexes.length === 0) {
    return [];
  }

  const total = health.redundantIndexes.reduce(
    (sum, index) => sum + index.bytes,
    0,
  );
  const lines = [
    "## Indexes another index already covers",
    "",
    "A btree on `(a)` answers nothing a btree on `(a, b)` does not. The shorter one is " +
      "pure write overhead: every insert and update maintains it, and no query needs it.",
    "",
    `Dropping all of these would return ${formatBytes(total)}.`,
    "",
    "| Table | Redundant | Covered by | Size | Fix |",
    "| --- | --- | --- | ---: | --- |",
  ];

  for (const index of health.redundantIndexes) {
    lines.push(
      `| \`${index.table}\` | \`${index.index}\` | \`${index.coveredBy}\` | ` +
        `${formatBytes(index.bytes)} | \`DROP INDEX CONCURRENTLY ${index.index};\` |`,
    );
  }
  lines.push("");
  return lines;
}

function unusedSection(health: SchemaHealth, now: Date): string[] {
  if (health.unusedIndexes.length === 0) {
    return [];
  }

  const total = health.unusedIndexes.reduce(
    (sum, index) => sum + index.bytes,
    0,
  );
  const window = health.statsSince
    ? describeAge(health.statsSince, now)
    : "an unknown period";

  const lines = [
    "## Indexes nothing has read",
    "",
    `Not scanned once in ${window}. Together they hold ${formatBytes(total)} and are ` +
      "maintained on every write to their table.",
    "",
    "Primary keys and unique constraints are excluded: they are not there to be read, " +
      "they enforce a rule, and dropping one for being unread drops the rule with it.",
    "",
    "| Table | Index | Size | Definition |",
    "| --- | --- | ---: | --- |",
  ];

  for (const index of health.unusedIndexes) {
    lines.push(
      `| \`${index.table}\` | \`${index.index}\` | ${formatBytes(index.bytes)} | ` +
        `\`${index.definition}\` |`,
    );
  }
  lines.push("");
  return lines;
}

function staleSection(health: SchemaHealth, small: number): string[] {
  // A table the planner's statistics no longer describe is how a good query
  // plan turns into a sequential scan overnight.
  const stale = health.tables
    .filter((table) => table.liveRows >= small)
    .filter(
      (table) =>
        table.modifiedSinceAnalyze >= Math.max(table.liveRows * 0.1, 1000),
    )
    .sort((a, b) => b.modifiedSinceAnalyze - a.modifiedSinceAnalyze);

  const bloated = health.tables
    .filter((table) => table.liveRows >= small)
    .filter((table) => table.deadRows >= table.liveRows * 0.2)
    .sort((a, b) => b.deadRows - a.deadRows);

  if (stale.length === 0 && bloated.length === 0) {
    return [];
  }

  const lines = ["## Tables the planner may be guessing about", ""];

  if (stale.length > 0) {
    lines.push(
      "These have changed substantially since the planner last measured them. Stale " +
        "statistics are how a good plan turns into a sequential scan overnight.",
      "",
      "| Table | Rows | Changed since last ANALYZE | Last analysed |",
      "| --- | ---: | ---: | --- |",
    );
    for (const table of stale) {
      lines.push(
        `| \`${table.table}\` | ${table.liveRows.toLocaleString()} | ` +
          `${table.modifiedSinceAnalyze.toLocaleString()} | ` +
          `${table.lastAnalyze ? table.lastAnalyze.toISOString() : "never"} |`,
      );
    }
    lines.push("");
  }

  if (bloated.length > 0) {
    lines.push(
      "These are carrying dead rows that vacuum has not reclaimed. The space is still " +
        "read on every sequential scan.",
      "",
      "| Table | Live rows | Dead rows | Last vacuumed |",
      "| --- | ---: | ---: | --- |",
    );
    for (const table of bloated) {
      lines.push(
        `| \`${table.table}\` | ${table.liveRows.toLocaleString()} | ` +
          `${table.deadRows.toLocaleString()} | ` +
          `${table.lastVacuum ? table.lastVacuum.toISOString() : "never"} |`,
      );
    }
    lines.push("");
  }

  return lines;
}

export function describeAge(from: Date, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - from.getTime()) / 1000);
  if (seconds < 90) {
    return plural(Math.round(seconds), "second");
  }
  const minutes = seconds / 60;
  // Up to two hours in minutes, because "90 minutes" is what a person says and
  // rounding it to "2 hours" overstates the window in the one place where
  // overstating it changes what someone does.
  if (minutes < 120) {
    return plural(Math.round(minutes), "minute");
  }
  const hours = minutes / 60;
  if (hours < 48) {
    return plural(Math.round(hours), "hour");
  }
  return plural(Math.round(hours / 24), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
