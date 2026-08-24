import { QueryPlan } from './types';

/**
 * The shape of a query plan.
 *
 * EXPLAIN (FORMAT JSON) is a Postgres format, so reading it belongs in the
 * adapter layer next to the code that asks for it — not above, where the rest
 * of the extension is meant to hold no engine-specific knowledge at all.
 */

export interface PlanNode {
  readonly [key: string]: unknown;
}

/** Unwraps whatever EXPLAIN (FORMAT JSON) handed back into the root node. */
export function rootOf(plan: QueryPlan): PlanNode | undefined {
  const raw = plan.raw as unknown;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first || typeof first !== 'object') {
    return undefined;
  }
  const wrapper = first as Record<string, unknown>;
  const node = wrapper['Plan'] ?? wrapper;
  return node && typeof node === 'object' ? (node as PlanNode) : undefined;
}

/** Every node in the tree, parents before children. */
export function walk(node: PlanNode | undefined): PlanNode[] {
  if (!node) {
    return [];
  }
  const children = Array.isArray(node['Plans']) ? (node['Plans'] as PlanNode[]) : [];
  return [node, ...children.flatMap((child) => walk(child))];
}

/** Total estimated cost of the whole plan, as the planner scored it. */
export function totalCost(plan: QueryPlan): number {
  return numberOr(rootOf(plan)?.['Total Cost'], 0);
}

/** Measured milliseconds, present only when the plan was run with ANALYZE. */
export function executionMs(plan: QueryPlan): number | undefined {
  const raw = plan.raw as unknown;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first || typeof first !== 'object') {
    return undefined;
  }
  const wrapper = first as Record<string, unknown>;
  const total =
    optionalNumber(wrapper['Execution Time']) ?? optionalNumber(wrapper['Total Runtime']);
  const planning = optionalNumber(wrapper['Planning Time']) ?? 0;
  return total === undefined ? undefined : total + planning;
}

/**
 * Every index the plan names.
 *
 * Used to answer the only question that matters about a proposed index: did
 * the planner reach for it. An index that is built and ignored costs write
 * throughput and disk and buys nothing.
 */
export function indexNames(plan: QueryPlan): Set<string> {
  const names = new Set<string>();
  for (const node of walk(rootOf(plan))) {
    const name = node['Index Name'];
    if (typeof name === 'string') {
      names.add(name);
    }
  }
  return names;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
