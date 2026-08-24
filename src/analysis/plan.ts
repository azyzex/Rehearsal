/**
 * Query plans, turned into something worth looking at.
 *
 * Postgres will tell you exactly how it intends to answer a query, and almost
 * nobody reads it, because the raw output is a wall of parenthesised numbers.
 * The information that matters is nearly always one of three things: which node
 * actually took the time, whether anything is scanning a large table
 * sequentially, and whether the planner's estimate was wildly wrong.
 *
 * Node *width* comes from actual time, not estimated cost. A plan drawn by cost
 * shows you what the planner believed; the interesting cases are exactly the
 * ones where it believed wrong.
 */

export interface PlanNode {
  readonly kind: string;
  /** The relation this node reads, when it reads one. */
  readonly relation?: string;
  /** Milliseconds actually spent here and below. */
  readonly totalMs: number;
  /** Milliseconds spent here alone, with children subtracted. */
  readonly selfMs: number;
  readonly actualRows: number;
  readonly estimatedRows: number;
  readonly children: readonly PlanNode[];
}

export interface PlanInsight {
  readonly kind: 'sequential-scan' | 'bad-estimate' | 'most-expensive';
  readonly message: string;
  readonly node: string;
}

export interface AnalysedPlan {
  readonly root: PlanNode;
  readonly totalMs: number;
  readonly insights: readonly PlanInsight[];
}

export interface PlanThresholds {
  /** Rows above which a sequential scan is worth mentioning. */
  readonly largeTable: number;
  /** How far an estimate may be out before it is called wrong. */
  readonly estimateFactor: number;
}

export const DEFAULT_PLAN_THRESHOLDS: PlanThresholds = {
  largeTable: 100_000,
  estimateFactor: 10,
};

/**
 * Parses the JSON `EXPLAIN` produces.
 *
 * The shape is stable across versions but verbose, and every field is optional
 * in practice — a plan without ANALYZE has no actual times at all. Anything
 * missing becomes zero rather than throwing, because a partial plan is still
 * worth drawing and a crash here would take the whole preview with it.
 */
export function parsePlan(raw: unknown): PlanNode | undefined {
  // EXPLAIN (FORMAT JSON) returns [{ "Plan": {...} }].
  const first = Array.isArray(raw) ? raw[0] : raw;
  const plan = isRecord(first) ? first['Plan'] : undefined;
  return isRecord(plan) ? toNode(plan) : undefined;
}

function toNode(plan: Record<string, unknown>): PlanNode {
  const children = Array.isArray(plan['Plans'])
    ? plan['Plans'].filter(isRecord).map(toNode)
    : [];

  // `Actual Total Time` is per loop, so a node inside a nested loop has to be
  // multiplied by how many times it ran. Reading it raw understates the cost of
  // exactly the nodes most likely to be the problem.
  const loops = number(plan['Actual Loops']) || 1;
  const totalMs = number(plan['Actual Total Time']) * loops;
  const childrenMs = children.reduce((sum, child) => sum + child.totalMs, 0);

  const relation = plan['Relation Name'];

  return {
    kind: String(plan['Node Type'] ?? 'Unknown'),
    ...(typeof relation === 'string' ? { relation } : {}),
    totalMs,
    selfMs: Math.max(0, totalMs - childrenMs),
    actualRows: number(plan['Actual Rows']) * loops,
    estimatedRows: number(plan['Plan Rows']) * loops,
    children,
  };
}

export function analysePlan(
  root: PlanNode,
  thresholds: PlanThresholds = DEFAULT_PLAN_THRESHOLDS,
): AnalysedPlan {
  const insights: PlanInsight[] = [];
  const nodes: PlanNode[] = [];

  const walk = (node: PlanNode): void => {
    nodes.push(node);
    node.children.forEach(walk);
  };
  walk(root);

  // A sequential scan is not a problem in itself — on a small table it is the
  // right choice, and saying otherwise would be the cargo-cult version of this
  // advice. It is only worth mentioning on a table big enough for the read to
  // cost something.
  for (const node of nodes) {
    if (node.kind === 'Seq Scan' && node.actualRows > thresholds.largeTable) {
      insights.push({
        kind: 'sequential-scan',
        node: describe(node),
        message:
          `${describe(node)} reads ${format(node.actualRows)} rows sequentially. ` +
          `An index on the filtered columns would avoid it.`,
      });
    }
  }

  // A planner working from stale statistics makes bad choices everywhere
  // downstream, so a wrong estimate is worth surfacing even when this
  // particular query was fast.
  for (const node of nodes) {
    if (node.estimatedRows <= 0 || node.actualRows <= 0) {
      continue;
    }
    const ratio =
      node.actualRows > node.estimatedRows
        ? node.actualRows / node.estimatedRows
        : node.estimatedRows / node.actualRows;

    if (ratio >= thresholds.estimateFactor) {
      insights.push({
        kind: 'bad-estimate',
        node: describe(node),
        message:
          `${describe(node)} expected ${format(node.estimatedRows)} rows and got ` +
          `${format(node.actualRows)}. The planner is working from stale statistics — ` +
          `an ANALYZE would fix it.`,
      });
    }
  }

  // The single node worth looking at first, by time spent in it rather than
  // beneath it.
  const worst = nodes.reduce((a, b) => (b.selfMs > a.selfMs ? b : a), nodes[0]!);
  if (worst && worst.selfMs > 0 && root.totalMs > 0) {
    const share = Math.round((worst.selfMs / root.totalMs) * 100);
    if (share >= 20) {
      insights.push({
        kind: 'most-expensive',
        node: describe(worst),
        message: `${describe(worst)} is ${share}% of the total time on its own.`,
      });
    }
  }

  return { root, totalMs: root.totalMs, insights };
}

function describe(node: PlanNode): string {
  return node.relation ? `${node.kind} on ${node.relation}` : node.kind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function format(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
