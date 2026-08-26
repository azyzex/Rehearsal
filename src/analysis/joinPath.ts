import { SchemaSnapshot } from '../adapters/types';

/**
 * How do I get from this table to that one?
 *
 * Every developer answers this by hand, repeatedly, by opening a schema
 * diagram and tracing relationships with a finger. The database already knows
 * the answer — the foreign keys *are* the graph — so it may as well be walked.
 *
 * Shortest path by number of joins, breadth-first. Foreign keys are followed in
 * both directions, because a join does not care which side declared the
 * constraint: `orders` reaches `users` whether the key points that way or the
 * other. When several paths are the same length the first one found wins, which
 * is stable because the edge list is in a fixed order.
 */

export interface JoinStep {
  readonly from: string;
  readonly to: string;
  /** `from`'s columns, in the same order as `toColumns`. */
  readonly fromColumns: readonly string[];
  readonly toColumns: readonly string[];
  /** The constraint that made this step possible. */
  readonly via: string;
}

export interface JoinPath {
  readonly from: string;
  readonly to: string;
  readonly steps: readonly JoinStep[];
  /** Tables along the way, in order, including both ends. */
  readonly tables: readonly string[];
  /** A runnable SELECT that walks it, for the engines that take SQL. */
  readonly sql: string;
  /** The same route as an aggregation pipeline, for the one that does not. */
  readonly pipeline: string;
}

export function findJoinPath(
  snapshot: SchemaSnapshot,
  from: string,
  to: string,
): JoinPath | undefined {
  if (from === to) {
    // Asking for the route from a table to itself is only an interesting
    // question when the table references itself — a category hierarchy, an
    // employee's manager. The useful answer there is the self-join, not "you
    // are already there", and a shortest-path search cannot give it because it
    // refuses to revisit a table.
    const loop = snapshot.foreignKeys.find((fk) => fk.fromTable === from && fk.toTable === from);
    const steps: JoinStep[] = loop
      ? [
          {
            from,
            to,
            fromColumns: loop.fromColumns,
            toColumns: loop.toColumns,
            via: loop.name,
          },
        ]
      : [];

    return {
      from,
      to,
      steps,
      tables: steps.length > 0 ? [from, to] : [from],
      sql: toSelect(from, steps),
      pipeline: toPipeline(from, steps),
    };
  }

  // Adjacency in both directions, since a join is symmetric even though a
  // foreign key is not.
  const neighbours = new Map<string, JoinStep[]>();
  const link = (step: JoinStep): void => {
    const list = neighbours.get(step.from) ?? [];
    list.push(step);
    neighbours.set(step.from, list);
  };

  for (const fk of snapshot.foreignKeys) {
    link({
      from: fk.fromTable,
      to: fk.toTable,
      fromColumns: fk.fromColumns,
      toColumns: fk.toColumns,
      via: fk.name,
    });
    link({
      from: fk.toTable,
      to: fk.fromTable,
      fromColumns: fk.toColumns,
      toColumns: fk.fromColumns,
      via: fk.name,
    });
  }

  const previous = new Map<string, JoinStep>();
  const seen = new Set<string>([from]);
  let frontier = [from];

  while (frontier.length > 0) {
    const next: string[] = [];

    for (const table of frontier) {
      for (const step of neighbours.get(table) ?? []) {
        if (seen.has(step.to)) {
          continue;
        }
        seen.add(step.to);
        previous.set(step.to, step);

        if (step.to === to) {
          return build(from, to, previous);
        }
        next.push(step.to);
      }
    }

    frontier = next;
  }

  return undefined;
}

function build(from: string, to: string, previous: Map<string, JoinStep>): JoinPath {
  const steps: JoinStep[] = [];
  let cursor = to;

  while (cursor !== from) {
    const step = previous.get(cursor);
    if (!step) {
      break;
    }
    steps.unshift(step);
    cursor = step.from;
  }

  const tables = [from, ...steps.map((step) => step.to)];
  return {
    from,
    to,
    steps,
    tables,
    sql: toSelect(from, steps),
    pipeline: toPipeline(from, steps),
  };
}

/**
 * The path as a SELECT.
 *
 * Aliased by position rather than by name, because a path can revisit a table
 * — `users → orders → users` is a real shape when a table has two foreign keys
 * into the same place — and unaliased self-joins are ambiguous.
 */
function toSelect(from: string, steps: readonly JoinStep[]): string {
  const alias = (index: number): string => `t${index}`;
  const lines = [`SELECT *`, `  FROM ${quote(from)} AS ${alias(0)}`];

  steps.forEach((step, index) => {
    const left = alias(index);
    const right = alias(index + 1);
    const on = step.fromColumns
      .map((column, position) => {
        const target = step.toColumns[position] ?? step.toColumns[0] ?? column;
        return `${left}.${quoteIdent(column)} = ${right}.${quoteIdent(target)}`;
      })
      .join(' AND ');

    lines.push(`  JOIN ${quote(step.to)} AS ${right} ON ${on}`);
  });

  return lines.join('\n');
}

/**
 * The same route, as the aggregation pipeline MongoDB would run.
 *
 * There is no JOIN here and no SELECT, and handing a Mongo user a SELECT is
 * handing them something that cannot run against the database they are looking
 * at. `$lookup` is the operation that walks a reference, and `$unwind` after
 * each one keeps the shape flat enough to read — which is what someone asking
 * "how do I get from here to there" wants to see.
 *
 * Compound references are joined on `let`/`$expr`, because the short form of
 * `$lookup` matches a single field and would quietly drop the rest.
 */
function toPipeline(from: string, steps: readonly JoinStep[]): string {
  const stages: string[] = [];

  // Where the *local* side of the next lookup lives. After `$unwind: "$users"`
  // the fields of `users` are at `users.account_id`, not `account_id` — so
  // every step after the first has to reach through the one before it. Getting
  // this wrong produces a pipeline that runs, returns nothing, and looks right.
  let prefix = '';

  steps.forEach((step) => {
    const as = bare(step.to);
    const local = (column: string): string => `${prefix}${column}`;

    if (step.fromColumns.length === 1) {
      const target = step.toColumns[0] ?? step.fromColumns[0]!;
      stages.push(
        [
          '  {',
          '    $lookup: {',
          `      from: ${json(bare(step.to))},`,
          `      localField: ${json(local(step.fromColumns[0]!))},`,
          `      foreignField: ${json(target)},`,
          `      as: ${json(as)}`,
          '    }',
          '  }',
        ].join('\n'),
      );
    } else {
      const lets = step.fromColumns
        .map((column) => `${varName(column)}: ${json('$' + local(column))}`)
        .join(', ');
      const matches = step.fromColumns
        .map((column, position) => {
          const target = step.toColumns[position] ?? step.toColumns[0] ?? column;
          return `{ $eq: [${json('$' + target)}, ${json('$$' + varName(column))}] }`;
        })
        .join(', ');

      stages.push(
        [
          '  {',
          '    $lookup: {',
          `      from: ${json(bare(step.to))},`,
          `      let: { ${lets} },`,
          `      pipeline: [{ $match: { $expr: { $and: [${matches}] } } }],`,
          `      as: ${json(as)}`,
          '    }',
          '  }',
        ].join('\n'),
      );
    }

    stages.push(`  { $unwind: ${json('$' + as)} }`);
    prefix = `${as}.`;
  });

  return `db.getCollection(${json(bare(from))}).aggregate([\n${stages.join(',\n')}\n])`;
}

/** A collection name has no schema qualifier in front of it. */
function bare(name: string): string {
  const at = name.lastIndexOf('.');
  return at === -1 ? name : name.slice(at + 1);
}

/** A `let` variable name: dots are not allowed in one. */
function varName(column: string): string {
  return column.replace(/[^A-Za-z0-9_]/g, '_');
}

function json(value: string): string {
  return JSON.stringify(value);
}

function quote(table: string): string {
  return table.split('.').map(quoteIdent).join('.');
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
