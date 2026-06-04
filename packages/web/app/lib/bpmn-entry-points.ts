/**
 * Entry points of an intent — the BPMN flow nodes where work *enters* an
 * intent's pool. A node is an entry point of its pool when it has no
 * incoming sequence flow (`flows_to`) from another node in the *same*
 * pool: either it is a genuine source (no incoming sequence flow at all)
 * or every incoming flow hands off from a different intent's pool.
 *
 * The renderer guarantees that whenever an intent is rendered, all of its
 * entry points render alongside it (budget permitting) — so a process is
 * never shown starting "mid-stream" with its way-in clipped off.
 */

interface EntryPointNode {
  id: string;
  pool_id: string;
}

interface EntryPointLink {
  source: string;
  target: string;
  edge_type: string;
}

const SEQUENCE_FLOW_EDGES: ReadonlySet<string> = new Set(["flows_to"]);

export function computeIntentEntryPointIds(
  nodes: readonly EntryPointNode[],
  links: readonly EntryPointLink[],
): Set<string> {
  const poolByNode = new Map(nodes.map((node) => [node.id, node.pool_id]));
  // Nodes that receive a sequence flow from another node in the same pool.
  // Those are mid-stream continuations, not entry points.
  const hasSamePoolInflow = new Set<string>();

  for (const link of links) {
    if (!SEQUENCE_FLOW_EDGES.has(link.edge_type)) continue;
    const sourcePool = poolByNode.get(link.source);
    const targetPool = poolByNode.get(link.target);
    // Skip edges whose endpoints are not both in the rendered node set —
    // a flow from a filtered-out node can't anchor a same-pool predecessor.
    if (sourcePool === undefined || targetPool === undefined) continue;
    if (sourcePool === targetPool) hasSamePoolInflow.add(link.target);
  }

  const entry = new Set<string>();
  for (const node of nodes) {
    if (!hasSamePoolInflow.has(node.id)) entry.add(node.id);
  }
  return entry;
}

interface RankableEntryNode extends EntryPointNode {
  created_at?: string | null;
}

/**
 * The single entry point of a pool to surface when focusing its intent:
 * the process "start" — the earliest-created entry point. When an intent
 * is focused, the BPMN perspective doesn't fan out the whole swim lane;
 * it homes in on this one "way in" to the process.
 *
 * Returns `null` when the pool has no entry point in the given node set
 * (e.g. every node was filtered out), so the caller can fall back to the
 * intent itself.
 *
 * Deterministic with no ranking input: earliest `created_at` wins, ties
 * broken by the lower id — so the same focus lands on the same node
 * across renders.
 */
export function topEntryPointId(
  poolId: string,
  nodes: readonly RankableEntryNode[],
  links: readonly EntryPointLink[],
): string | null {
  const entryIds = computeIntentEntryPointIds(nodes, links);
  let best: RankableEntryNode | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.pool_id !== poolId || !entryIds.has(node.id)) continue;
    const time = node.created_at ? Date.parse(node.created_at) : Number.POSITIVE_INFINITY;
    if (
      best === null ||
      time < bestTime ||
      (time === bestTime && node.id.localeCompare(best.id) < 0)
    ) {
      best = node;
      bestTime = time;
    }
  }
  return best?.id ?? null;
}
