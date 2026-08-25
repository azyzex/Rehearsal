import { ColumnInfo, ForeignKeyInfo, SchemaSnapshot, SchemaTable } from '../adapters/types';

/**
 * What is different between two databases.
 *
 * The question is almost always the same one: staging and production are
 * supposed to be the same shape, and something has gone wrong that only happens
 * in one of them. The answer is usually a column somebody added by hand at two
 * in the morning, an index that exists in one place, or a NOT NULL that was
 * applied to staging and forgotten.
 *
 * Pure, and deliberately one-directional in its wording: everything is phrased
 * as what would have to change in the second database to make it match the
 * first. "Different" is not actionable; "add this column to staging" is.
 */

export interface ColumnDifference {
  readonly column: string;
  readonly what: 'type' | 'nullability' | 'default';
  readonly left: string;
  readonly right: string;
}

export interface TableDifference {
  readonly table: string;
  readonly onlyInLeft: readonly string[];
  readonly onlyInRight: readonly string[];
  readonly changed: readonly ColumnDifference[];
}

export interface SchemaComparison {
  /** Tables the first database has and the second does not. */
  readonly tablesOnlyInLeft: readonly string[];
  readonly tablesOnlyInRight: readonly string[];
  /** Tables in both, where something inside them differs. */
  readonly tables: readonly TableDifference[];
  readonly foreignKeysOnlyInLeft: readonly string[];
  readonly foreignKeysOnlyInRight: readonly string[];
  /** True when nothing at all differs. */
  readonly identical: boolean;
}

export function compareSchemas(left: SchemaSnapshot, right: SchemaSnapshot): SchemaComparison {
  const leftTables = byName(left.tables);
  const rightTables = byName(right.tables);

  const tablesOnlyInLeft = [...leftTables.keys()].filter((name) => !rightTables.has(name)).sort();
  const tablesOnlyInRight = [...rightTables.keys()].filter((name) => !leftTables.has(name)).sort();

  const tables: TableDifference[] = [];
  for (const [name, leftTable] of [...leftTables].sort(([a], [b]) => a.localeCompare(b))) {
    const rightTable = rightTables.get(name);
    if (!rightTable) {
      continue;
    }
    const difference = compareTable(name, leftTable, rightTable);
    if (
      difference.onlyInLeft.length > 0 ||
      difference.onlyInRight.length > 0 ||
      difference.changed.length > 0
    ) {
      tables.push(difference);
    }
  }

  const leftKeys = new Set(left.foreignKeys.map(describeKey));
  const rightKeys = new Set(right.foreignKeys.map(describeKey));
  const foreignKeysOnlyInLeft = [...leftKeys].filter((key) => !rightKeys.has(key)).sort();
  const foreignKeysOnlyInRight = [...rightKeys].filter((key) => !leftKeys.has(key)).sort();

  return {
    tablesOnlyInLeft,
    tablesOnlyInRight,
    tables,
    foreignKeysOnlyInLeft,
    foreignKeysOnlyInRight,
    identical:
      tablesOnlyInLeft.length === 0 &&
      tablesOnlyInRight.length === 0 &&
      tables.length === 0 &&
      foreignKeysOnlyInLeft.length === 0 &&
      foreignKeysOnlyInRight.length === 0,
  };
}

function compareTable(
  table: string,
  left: SchemaTable,
  right: SchemaTable,
): TableDifference {
  const leftColumns = new Map(left.columns.map((column) => [column.name, column]));
  const rightColumns = new Map(right.columns.map((column) => [column.name, column]));

  const changed: ColumnDifference[] = [];
  for (const [name, leftColumn] of leftColumns) {
    const rightColumn = rightColumns.get(name);
    if (!rightColumn) {
      continue;
    }
    changed.push(...compareColumn(name, leftColumn, rightColumn));
  }

  return {
    table,
    onlyInLeft: [...leftColumns.keys()].filter((name) => !rightColumns.has(name)).sort(),
    onlyInRight: [...rightColumns.keys()].filter((name) => !leftColumns.has(name)).sort(),
    changed,
  };
}

function compareColumn(
  column: string,
  left: ColumnInfo,
  right: ColumnInfo,
): ColumnDifference[] {
  const differences: ColumnDifference[] = [];

  if (left.type !== right.type) {
    differences.push({ column, what: 'type', left: left.type, right: right.type });
  }

  if (left.nullable !== right.nullable) {
    differences.push({
      column,
      what: 'nullability',
      // Spelled out rather than as true/false: "NOT NULL" is what someone
      // would have to type, and "false" is not.
      left: left.nullable ? 'nullable' : 'NOT NULL',
      right: right.nullable ? 'nullable' : 'NOT NULL',
    });
  }

  const leftDefault = left.defaultExpression ?? '';
  const rightDefault = right.defaultExpression ?? '';
  if (leftDefault !== rightDefault) {
    differences.push({
      column,
      what: 'default',
      left: leftDefault || 'no default',
      right: rightDefault || 'no default',
    });
  }

  return differences;
}

/** A foreign key as a comparable sentence, since the names differ freely. */
function describeKey(key: ForeignKeyInfo): string {
  return `${key.fromTable} (${key.fromColumns.join(', ')}) -> ${key.toTable} (${key.toColumns.join(', ')})`;
}

function byName(tables: readonly SchemaTable[]): Map<string, SchemaTable> {
  return new Map(tables.map((table) => [table.qualified, table]));
}

export interface ComparisonNames {
  readonly left: string;
  readonly right: string;
}

/**
 * The comparison as markdown.
 *
 * Written as a list of what the second database is missing or has extra,
 * because that is the shape of the work. A report that only says "these are
 * different" leaves the reader to do the subtraction themselves.
 */
export function comparisonReport(
  comparison: SchemaComparison,
  names: ComparisonNames,
  now = new Date(),
): string {
  const lines = [
    '# Schema comparison',
    '',
    `**Reference:** ${names.left}  `,
    `**Compared:** ${names.right}  `,
    `**Read:** ${now.toISOString()}`,
    '',
  ];

  if (comparison.identical) {
    lines.push(
      `${names.right} has the same tables, columns, types, nullability, defaults and `,
      'foreign keys as the reference. Indexes, triggers, permissions and data are not',
      'compared.',
      '',
    );
    return lines.join('\n');
  }

  if (comparison.tablesOnlyInLeft.length > 0) {
    lines.push(
      `## Tables missing from ${names.right}`,
      '',
      ...comparison.tablesOnlyInLeft.map((table) => `- \`${table}\``),
      '',
    );
  }

  if (comparison.tablesOnlyInRight.length > 0) {
    lines.push(
      `## Tables ${names.right} has that the reference does not`,
      '',
      ...comparison.tablesOnlyInRight.map((table) => `- \`${table}\``),
      '',
    );
  }

  if (comparison.tables.length > 0) {
    lines.push('## Tables that differ inside', '');

    for (const table of comparison.tables) {
      lines.push(`### \`${table.table}\``, '');

      if (table.onlyInLeft.length > 0) {
        lines.push(
          `Columns missing from ${names.right}: ` +
            table.onlyInLeft.map((column) => `\`${column}\``).join(', '),
          '',
        );
      }
      if (table.onlyInRight.length > 0) {
        lines.push(
          `Columns only in ${names.right}: ` +
            table.onlyInRight.map((column) => `\`${column}\``).join(', '),
          '',
        );
      }
      if (table.changed.length > 0) {
        lines.push(
          `| Column | What | ${names.left} | ${names.right} |`,
          '| --- | --- | --- | --- |',
          ...table.changed.map(
            (difference) =>
              `| \`${difference.column}\` | ${difference.what} | ${difference.left} | ` +
              `${difference.right} |`,
          ),
          '',
        );
      }
    }
  }

  if (comparison.foreignKeysOnlyInLeft.length > 0) {
    lines.push(
      `## Foreign keys missing from ${names.right}`,
      '',
      ...comparison.foreignKeysOnlyInLeft.map((key) => `- \`${key}\``),
      '',
    );
  }

  if (comparison.foreignKeysOnlyInRight.length > 0) {
    lines.push(
      `## Foreign keys only in ${names.right}`,
      '',
      ...comparison.foreignKeysOnlyInRight.map((key) => `- \`${key}\``),
      '',
    );
  }

  lines.push(
    '---',
    '',
    'Compared: tables, columns, types, nullability, defaults, foreign keys.  ',
    'Not compared: indexes, constraints beyond foreign keys, triggers, permissions,',
    'extensions, sequences, and the data itself.',
    '',
  );

  return lines.join('\n');
}
