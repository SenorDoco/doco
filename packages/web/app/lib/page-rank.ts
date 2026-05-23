// Simple PageRank for the overview graph. Operates on the in-memory
// nodes + links the loader already pulled, so there's no DB round-trip
// or cache: we re-compute every load. The cost is ~O(iter * edges)
// and Docos rarely exceed a few hundred neurons, so even with 30
// iterations the computation is well under a millisecond.
//
// Edge direction follows the OverviewGraphLink shape: `source` confers
// rank to `target`. Dangling nodes (no out-edges) leak their rank to
// every node uniformly each iteration, matching the standard PR
// definition.

export interface RankableGraphLink {
  source: string;
  target: string;
}

export interface RankableGraphNode {
  id: string;
}

export interface PageRankOptions {
  damping?: number; // d, default 0.85
  iterations?: number; // default 30
}

/**
 * Returns a Map of node id → rank in [0, 1]. Ranks sum to ~1 across
 * all node ids (subject to floating-point drift).
 *
 * Nodes not present in `nodes` are ignored even if referenced from
 * `links` — the caller should pass the complete node list.
 */
export function computePageRank(
  nodes: readonly RankableGraphNode[],
  links: readonly RankableGraphLink[],
  options: PageRankOptions = {},
): Map<string, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;

  const n = nodes.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  const nodeIds = nodes.map((node) => node.id);
  const idSet = new Set(nodeIds);
  const baseRank = 1 / n;
  for (const id of nodeIds) result.set(id, baseRank);

  // Build adjacency: id -> [targetIds]
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const link of links) {
    if (!idSet.has(link.source) || !idSet.has(link.target)) continue;
    const list = outgoing.get(link.source);
    if (list) list.push(link.target);
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    // Dangling-node mass: rank from nodes with no out-edges spreads
    // uniformly to all nodes each iteration.
    let danglingSum = 0;
    for (const id of nodeIds) {
      const outs = outgoing.get(id);
      if (!outs || outs.length === 0) danglingSum += result.get(id) ?? 0;
    }

    const next = new Map<string, number>();
    const teleport = (1 - damping) / n + (damping * danglingSum) / n;
    for (const id of nodeIds) next.set(id, teleport);

    for (const id of nodeIds) {
      const outs = outgoing.get(id);
      if (!outs || outs.length === 0) continue;
      const share = (damping * (result.get(id) ?? 0)) / outs.length;
      for (const target of outs) {
        next.set(target, (next.get(target) ?? 0) + share);
      }
    }

    for (const id of nodeIds) result.set(id, next.get(id) ?? 0);
  }

  return result;
}
