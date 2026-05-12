import type { Database } from "better-sqlite3";
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
export const lintFollowsCycle = (db: Database): LintIssue[] => {
  const issues: LintIssue[] = [];

  // Build the follows adjacency: from → list of nodes it follows.
  const rows = db
    .prepare("SELECT from_id, to_id FROM edges WHERE edge_type = 'follows'")
    .all() as { from_id: string; to_id: string }[];

  const adj = new Map<string, string[]>();
  for (const r of rows) {
    let list = adj.get(r.from_id);
    if (!list) {
      list = [];
      adj.set(r.from_id, list);
    }
    list.push(r.to_id);
  }

  // DFS detecting cycles. Two color-states: visiting (on stack) / visited (done).
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reportedCycles = new Set<string>(); // canonical cycle key → reported once

  function dfs(node: string, stack: string[]): void {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      // Cycle: stack contains the path; find where the cycle starts.
      const start = stack.indexOf(node);
      if (start === -1) return;
      const cycle = stack.slice(start).concat(node);
      // Canonical key: rotate to lexicographically smallest start, then join.
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
