import { computeDepthFromCenter, depthBucket } from "./graph-depth";
import { pageRank } from "./pagerank";

export interface FocusSelectableNode {
  id: string;
  lifecycle?: string | null;
  created_at?: string | null;
}

export interface FocusSelectableLink {
  source: string;
  target: string;
}

export interface PersonalizedSelectionMeasurementContext {
  docoHandle?: string | null;
  perspective: string;
}

export interface PersonalizedSelectionOptions {
  minFirstDegree?: number;
}

export interface ExternalConnectionSummary {
  id: string;
  incoming: number;
  outgoing: number;
}

const PERSONALIZED_SELECTION_MEASURE_NAME = "doco.personalized-node-selection";
const PERSONALIZED_SELECTION_LOG_THRESHOLD_MS = 16;
let personalizedSelectionMeasureIndex = 0;

function lifecycleRank(lifecycle: string | null | undefined): number {
  switch (lifecycle ?? "asserted") {
    case "asserted":
      return 0;
    case "drafting":
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

function compareByRankAndFreshness(
  a: FocusSelectableNode,
  b: FocusSelectableNode,
  ranks: ReadonlyMap<string, number> | undefined,
  fallbackRanks: ReadonlyMap<string, number> | undefined,
): number {
  const rankDiff = (ranks?.get(b.id) ?? 0) - (ranks?.get(a.id) ?? 0);
  if (rankDiff !== 0) return rankDiff;
  const fallbackDiff = (fallbackRanks?.get(b.id) ?? 0) - (fallbackRanks?.get(a.id) ?? 0);
  if (fallbackDiff !== 0) return fallbackDiff;
  const lifecycleDiff = lifecycleRank(a.lifecycle) - lifecycleRank(b.lifecycle);
  if (lifecycleDiff !== 0) return lifecycleDiff;
  const dateDiff = createdMs(b) - createdMs(a);
  if (dateDiff !== 0) return dateDiff;
  return a.id.localeCompare(b.id);
}

function firstDegreeIds(
  links: readonly FocusSelectableLink[],
  focusId: string | null | undefined,
  selectableIds: ReadonlySet<string>,
): Set<string> {
  const direct = new Set<string>();
  if (!focusId) return direct;
  for (const link of links) {
    if (link.source === focusId && selectableIds.has(link.target)) direct.add(link.target);
    else if (link.target === focusId && selectableIds.has(link.source)) direct.add(link.source);
  }
  return direct;
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

export function selectPersonalizedNodeIds(
  nodes: readonly FocusSelectableNode[],
  links: readonly FocusSelectableLink[],
  focusId: string | null | undefined,
  fallbackRanks: ReadonlyMap<string, number> | undefined,
  limit: number,
  options: PersonalizedSelectionOptions = {},
): Set<string> {
  const max = Math.max(1, Math.floor(limit));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectableIds = new Set(byId.keys());
  const focusNodeId = focusId && byId.has(focusId) ? focusId : null;
  const ranks = focusNodeId
    ? pageRank(nodes, links, {
        iterations: 30,
        tolerance: 1e-5,
        personalization: new Map([[focusNodeId, 1]]),
      })
    : fallbackRanks;
  const selected = new Set<string>();
  if (focusNodeId) selected.add(focusNodeId);

  const ordered = [...nodes]
    .filter((node) => node.id !== focusNodeId)
    .sort((a, b) => compareByRankAndFreshness(a, b, ranks, fallbackRanks));

  const directIds = firstDegreeIds(links, focusId, selectableIds);
  const minFirstDegree = Math.max(0, Math.floor(options.minFirstDegree ?? 0));
  let firstDegreeCount = 0;
  for (const node of ordered) {
    if (selected.size >= max || firstDegreeCount >= minFirstDegree) break;
    if (!directIds.has(node.id)) continue;
    selected.add(node.id);
    firstDegreeCount++;
  }

  for (const node of ordered) {
    if (selected.size >= max) break;
    if (selected.has(node.id)) continue;
    selected.add(node.id);
  }
  return selected;
}

export function selectMeasuredPersonalizedNodeIds(
  nodes: readonly FocusSelectableNode[],
  links: readonly FocusSelectableLink[],
  focusId: string | null | undefined,
  fallbackRanks: ReadonlyMap<string, number> | undefined,
  limit: number,
  context: PersonalizedSelectionMeasurementContext,
  options: PersonalizedSelectionOptions = {},
): Set<string> {
  if (
    typeof window === "undefined" ||
    typeof window.performance?.mark !== "function" ||
    typeof window.performance?.measure !== "function"
  ) {
    return selectPersonalizedNodeIds(nodes, links, focusId, fallbackRanks, limit, options);
  }

  const perf = window.performance;
  const sequence = personalizedSelectionMeasureIndex++;
  const markBase = `${PERSONALIZED_SELECTION_MEASURE_NAME}:${sequence}`;
  const startMark = `${markBase}:start`;
  const endMark = `${markBase}:end`;

  perf.mark(startMark);
  const startedAt = perf.now();
  try {
    const selected = selectPersonalizedNodeIds(
      nodes,
      links,
      focusId,
      fallbackRanks,
      limit,
      options,
    );
    const durationMs = perf.now() - startedAt;
    const detail = {
      docoHandle: context.docoHandle ?? null,
      perspective: context.perspective,
      focusId: focusId ?? null,
      nodeCount: nodes.length,
      linkCount: links.length,
      limit: Math.max(1, Math.floor(limit)),
      minFirstDegree: Math.max(0, Math.floor(options.minFirstDegree ?? 0)),
      selectedCount: selected.size,
      durationMs,
    };

    perf.mark(endMark);
    try {
      perf.measure(PERSONALIZED_SELECTION_MEASURE_NAME, {
        start: startMark,
        end: endMark,
        detail,
      });
    } catch {
      perf.measure(PERSONALIZED_SELECTION_MEASURE_NAME, startMark, endMark);
    }

    if (
      durationMs >= PERSONALIZED_SELECTION_LOG_THRESHOLD_MS &&
      typeof console.info === "function"
    ) {
      console.info("[Doco perf] personalized node selection", detail);
    }

    return selected;
  } finally {
    perf.clearMarks(startMark);
    perf.clearMarks(endMark);
  }
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
