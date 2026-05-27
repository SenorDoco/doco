import { computeDepthFromCenter, depthBucket } from "./graph-depth";

export interface FocusSelectableNode {
  id: string;
  lifecycle?: string | null;
  created_at?: string | null;
}

export interface FocusSelectableLink {
  source: string;
  target: string;
}

export interface ExternalConnectionSummary {
  id: string;
  incoming: number;
  outgoing: number;
}

function lifecycleRank(lifecycle: string | null | undefined): number {
  switch (lifecycle ?? "active") {
    case "active":
      return 0;
    case "proposed":
      return 1;
    case "drafting":
      return 2;
    case "retired":
      return 3;
    default:
      return 4;
  }
}

function createdMs(node: FocusSelectableNode): number {
  const ms = Date.parse(node.created_at ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

export function highestRankedNodeId(
  nodes: readonly FocusSelectableNode[],
  ranks: ReadonlyMap<string, number> | undefined,
): string | null {
  let best: FocusSelectableNode | null = null;
  for (const node of nodes) {
    if (!best) {
      best = node;
      continue;
    }
    const rankDiff = (ranks?.get(node.id) ?? 0) - (ranks?.get(best.id) ?? 0);
    if (rankDiff > 0) {
      best = node;
      continue;
    }
    if (rankDiff < 0) continue;
    const lifecycleDiff = lifecycleRank(node.lifecycle) - lifecycleRank(best.lifecycle);
    if (lifecycleDiff < 0) {
      best = node;
      continue;
    }
    if (lifecycleDiff > 0) continue;
    const dateDiff = createdMs(node) - createdMs(best);
    if (dateDiff > 0 || (dateDiff === 0 && node.id.localeCompare(best.id) < 0)) best = node;
  }
  return best?.id ?? null;
}

export function selectFocusedNodeIds(
  nodes: readonly FocusSelectableNode[],
  links: readonly FocusSelectableLink[],
  focusId: string | null | undefined,
  ranks: ReadonlyMap<string, number> | undefined,
  limit: number,
): Set<string> {
  const max = Math.max(1, Math.floor(limit));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const effectiveFocus = focusId && byId.has(focusId) ? focusId : highestRankedNodeId(nodes, ranks);
  const selected = new Set<string>();
  if (effectiveFocus) selected.add(effectiveFocus);

  const depthById = computeDepthFromCenter([...nodes], [...links], effectiveFocus);
  const ordered = nodes
    .filter((node) => node.id !== effectiveFocus)
    .sort((a, b) => {
      const depthDiff = depthBucket(depthById.get(a.id)) - depthBucket(depthById.get(b.id));
      if (depthDiff !== 0) return depthDiff;
      const rankDiff = (ranks?.get(b.id) ?? 0) - (ranks?.get(a.id) ?? 0);
      if (rankDiff !== 0) return rankDiff;
      const lifecycleDiff = lifecycleRank(a.lifecycle) - lifecycleRank(b.lifecycle);
      if (lifecycleDiff !== 0) return lifecycleDiff;
      const dateDiff = createdMs(b) - createdMs(a);
      if (dateDiff !== 0) return dateDiff;
      return a.id.localeCompare(b.id);
    });

  for (const node of ordered) {
    if (selected.size >= max) break;
    selected.add(node.id);
  }
  return selected;
}

export function summarizeExternalConnections(
  links: readonly FocusSelectableLink[],
  renderedIds: ReadonlySet<string>,
  renderableIds?: ReadonlySet<string>,
): ExternalConnectionSummary[] {
  const summaries = new Map<string, ExternalConnectionSummary>();
  const ensure = (id: string) => {
    let summary = summaries.get(id);
    if (!summary) {
      summary = { id, incoming: 0, outgoing: 0 };
      summaries.set(id, summary);
    }
    return summary;
  };

  for (const link of links) {
    if (renderableIds && (!renderableIds.has(link.source) || !renderableIds.has(link.target))) {
      continue;
    }
    const sourceRendered = renderedIds.has(link.source);
    const targetRendered = renderedIds.has(link.target);
    if (sourceRendered === targetRendered) continue;
    if (sourceRendered) ensure(link.source).outgoing += 1;
    else ensure(link.target).incoming += 1;
  }

  return Array.from(summaries.values()).sort((a, b) => {
    const countDiff = b.incoming + b.outgoing - (a.incoming + a.outgoing);
    if (countDiff !== 0) return countDiff;
    return a.id.localeCompare(b.id);
  });
}
