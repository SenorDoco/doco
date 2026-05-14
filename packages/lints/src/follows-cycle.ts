import type { PoolClient } from "pg";
import type { LintIssue } from "./types.js";

/**
 * Cycle-forbidding lint for the `follows` edge type (ADR-077).
 *
 * `follows` declares ordering / dependency: A follows B means A comes after
 * B. A cycle (A follows B follows … follows A) is meaningless and would
 * break any topological traversal — flag it as an error.
 *
 * Algorithm: DFS from every node, tracking the recursion stack. If we hit a
 * node already on the stack, we've closed a cycle.
 */
export const lintFollowsCycle = async (
  c: PoolClient,
  docoId: string,
): Promise<LintIssue[]> => {
  const issues: LintIssue[] = [];

  const rows = (
    await c.query<{ from_id: string; to_id: string }>(
      `SELECT from_id, to_id FROM edges
        WHERE edge_type = 'follows' AND doco_id = $1`,
      [docoId],
    )
  ).rows;

  const adj = new Map<string, string[]>();
  for (const r of rows) {
    let list = adj.get(r.from_id);
    if (!list) {
      list = [];
      adj.set(r.from_id, list);
    }
    list.push(r.to_id);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reportedCycles = new Set<string>();

  function dfs(node: string, stack: string[]): void {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      if (start === -1) return;
      const cycle = stack.slice(start).concat(node);
      const minIdx = cycle.indexOf(cycle.slice(0, -1).reduce((a, b) => (a < b ? a : b)));
      const canon = [...cycle.slice(minIdx, -1), ...cycle.slice(0, minIdx)].join("→");
      if (reportedCycles.has(canon)) return;
      reportedCycles.add(canon);
      issues.push({
        lintId: "follows-cycle",
        severity: "error",
        source: cycle[0]!,
        message: `Cycle in 'follows' relation: ${cycle.join(" → ")}. Per ADR-077, lint forbids cycles.`,
      });
      return;
    }
    visiting.add(node);
    stack.push(node);
    const out = adj.get(node) ?? [];
    for (const next of out) {
      dfs(next, stack);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) dfs(node, []);
  }

  return issues;
};
