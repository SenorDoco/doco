interface ProcessFocusPoolLike {
  id: string;
  intent_id: string | null;
}

interface ProcessFocusNodeLike {
  id: string;
  pool_id: string;
}

interface FocusDepthLinkLike {
  source: string;
  target: string;
}

export function linksWithFocusedPoolMembership(
  pools: readonly ProcessFocusPoolLike[],
  nodes: readonly ProcessFocusNodeLike[],
  links: readonly FocusDepthLinkLike[],
  centerId: string | null | undefined,
): FocusDepthLinkLike[] {
  // In BPMN, an Intent renders as the pool header. When that header is
  // focused, every rendered node inside the pool is direct context even
  // if the membership came from server-side grouping instead of a stored
  // edge.
  const focusedPool = pools.find((pool) => pool.intent_id === centerId);
  if (!focusedPool || !centerId) return [...links];

  const out = [...links];
  const seen = new Set(links.map((link) => undirectedLinkKey(link.source, link.target)));
  for (const node of nodes) {
    if (node.pool_id !== focusedPool.id || node.id === centerId) continue;
    const key = undirectedLinkKey(centerId, node.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: centerId, target: node.id });
  }

  return out;
}

function undirectedLinkKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
