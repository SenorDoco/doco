/**
 * PageRank over a directed graph of neurons + synapses, with an
 * optional personalization vector for "personalized PageRank" from a
 * focal node.
 *
 * Used by the BPMN perspective to pick a primary Intent when a neuron
 * lists multiple `intent_ids`. With no focal node, the unweighted
 * teleport distribution gives standard PageRank — the Intent that the
 * graph's structure says is most important wins. With a focal node,
 * teleport biases back to the focal so the Intent most relevant *to
 * that neuron's neighbourhood* wins.
 *
 * Algorithm: power iteration. ~50 iterations is far more than enough
 * for the graph sizes we render here (typically < 1k neurons, < 5k
 * edges); the loop terminates early when the L1 delta drops below
 * `tolerance`.
 */

export interface PageRankNode {
  id: string;
}

export interface PageRankEdge {
  source: string;
  target: string;
}

export interface PageRankOptions {
  /** Random-walk damping factor (1 - teleport probability). Default 0.85. */
  damping?: number;
  /** Hard cap on iterations. Default 50. */
  iterations?: number;
  /** L1 convergence threshold; loop exits early once met. Default 1e-6. */
  tolerance?: number;
  /**
   * Personalization vector. Keyed by node id; values are relative
   * weights (no need to sum to 1 — the function normalizes). When
   * omitted, every node gets equal teleport weight = standard PageRank.
   * When supplied with a single non-zero entry, that's "personalized
   * PageRank from that focal node."
   */
  personalization?: Map<string, number> | null;
}

export function pageRank(
  nodes: readonly PageRankNode[],
  edges: readonly PageRankEdge[],
  opts: PageRankOptions = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 50;
  const tolerance = opts.tolerance ?? 1e-6;

  const ids = nodes.map((n) => n.id);
  const n = ids.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  // Normalize the teleport vector. Default = uniform; personalization
  // = the supplied weights (renormalized to sum to 1).
  const teleport = new Map<string, number>();
  if (opts.personalization && opts.personalization.size > 0) {
    let total = 0;
    for (const w of opts.personalization.values()) total += w > 0 ? w : 0;
    if (total <= 0) {
      // All weights non-positive — fall back to uniform.
      for (const id of ids) teleport.set(id, 1 / n);
    } else {
      for (const id of ids) {
        const w = opts.personalization.get(id);
        teleport.set(id, w && w > 0 ? w / total : 0);
      }
    }
  } else {
    for (const id of ids) teleport.set(id, 1 / n);
  }

  // Outgoing adjacency. Edges into / out of unknown ids are dropped
  // so a stale link can't corrupt the iteration.
  const idSet = new Set(ids);
  const outgoing = new Map<string, string[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    (outgoing.get(e.source) as string[]).push(e.target);
  }

  // Seed with the teleport distribution.
  let rank = new Map<string, number>(teleport);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    for (const id of ids) next.set(id, (1 - damping) * (teleport.get(id) ?? 0));

    // Walk the current rank → distribute through outgoing edges.
    // Dangling nodes (no out-edges) leak their mass to the teleport
    // distribution; standard PageRank handles them this way.
    let danglingMass = 0;
    for (const id of ids) {
      const r = rank.get(id) ?? 0;
      const out = outgoing.get(id) ?? [];
      if (out.length === 0) {
        danglingMass += r;
        continue;
      }
      const share = (damping * r) / out.length;
      for (const t of out) {
        next.set(t, (next.get(t) ?? 0) + share);
      }
    }
    if (danglingMass > 0) {
      for (const id of ids) {
        next.set(id, (next.get(id) ?? 0) + damping * danglingMass * (teleport.get(id) ?? 0));
      }
    }

    // Convergence check (L1 delta).
    let delta = 0;
    for (const id of ids) {
      delta += Math.abs((next.get(id) ?? 0) - (rank.get(id) ?? 0));
    }
    rank = next;
    if (delta < tolerance) break;
  }

  return rank;
}

/**
 * Convenience: from a list of candidate ids, return the one with the
 * highest PageRank score. Ties broken by the order of `candidates`.
 * Returns null when the list is empty.
 */
export function highestRanked(
  candidates: readonly string[],
  rank: Map<string, number>,
): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0] ?? null;
  let bestScore = best ? (rank.get(best) ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i] as string;
    const s = rank.get(c) ?? Number.NEGATIVE_INFINITY;
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
