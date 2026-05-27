export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CanvasRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RenderWindowCandidate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Lower values win when the viewport contains more nodes than the
   * render budget. Callers use this for focal nodes, graph-depth, and
   * lifecycle-specific tie breaking.
   */
  priority?: number;
}

export interface RenderWindowOptions {
  viewport: FlowViewport;
  size: ViewportSize;
  maxItems: number;
  overscanPx?: number;
  mustIncludeIds?: Iterable<string | null | undefined>;
}

export interface RenderWindowSelection {
  ids: Set<string>;
  viewportRect: CanvasRect;
  overscanRect: CanvasRect;
  capped: boolean;
  candidateCount: number;
  intersectingCount: number;
}

const MIN_ZOOM = 0.0001;

export function rectForViewport(
  viewport: FlowViewport,
  size: ViewportSize,
  overscanPx = 0,
): CanvasRect {
  const zoom = Math.max(MIN_ZOOM, viewport.zoom);
  return {
    minX: (-viewport.x - overscanPx) / zoom,
    minY: (-viewport.y - overscanPx) / zoom,
    maxX: (size.width - viewport.x + overscanPx) / zoom,
    maxY: (size.height - viewport.y + overscanPx) / zoom,
  };
}

export function rectForCandidate(candidate: RenderWindowCandidate): CanvasRect {
  return {
    minX: candidate.x,
    minY: candidate.y,
    maxX: candidate.x + Math.max(1, candidate.width),
    maxY: candidate.y + Math.max(1, candidate.height),
  };
}

export function rectsIntersect(a: CanvasRect, b: CanvasRect): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

export function selectRenderWindow(
  candidates: readonly RenderWindowCandidate[],
  options: RenderWindowOptions,
): RenderWindowSelection {
  const maxItems = Math.max(1, Math.floor(options.maxItems));
  const viewportRect = rectForViewport(options.viewport, options.size, 0);
  const overscanRect = rectForViewport(options.viewport, options.size, options.overscanPx ?? 0);
  const mustInclude = new Set(
    Array.from(options.mustIncludeIds ?? []).filter((id): id is string => Boolean(id)),
  );
  const ids = new Set<string>();
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  for (const id of mustInclude) {
    if (byId.has(id)) ids.add(id);
  }

  const viewportCenter = {
    x: (viewportRect.minX + viewportRect.maxX) / 2,
    y: (viewportRect.minY + viewportRect.maxY) / 2,
  };
  const intersecting = candidates
    .flatMap((candidate) => {
      if (ids.has(candidate.id)) return [];
      const rect = rectForCandidate(candidate);
      if (!rectsIntersect(rect, overscanRect)) return [];
      const centerX = (rect.minX + rect.maxX) / 2;
      const centerY = (rect.minY + rect.maxY) / 2;
      const dx = centerX - viewportCenter.x;
      const dy = centerY - viewportCenter.y;
      return [
        {
          candidate,
          directlyVisible: rectsIntersect(rect, viewportRect),
          distanceSq: dx * dx + dy * dy,
        },
      ];
    })
    .sort((a, b) => {
      if (a.directlyVisible !== b.directlyVisible) return a.directlyVisible ? -1 : 1;
      const priorityDiff = (a.candidate.priority ?? 1000) - (b.candidate.priority ?? 1000);
      if (priorityDiff !== 0) return priorityDiff;
      const distanceDiff = a.distanceSq - b.distanceSq;
      if (distanceDiff !== 0) return distanceDiff;
      return a.candidate.id.localeCompare(b.candidate.id);
    });

  for (const { candidate } of intersecting) {
    if (ids.size >= maxItems) break;
    ids.add(candidate.id);
  }

  return {
    ids,
    viewportRect,
    overscanRect,
    capped: ids.size < mustInclude.size + intersecting.length,
    candidateCount: candidates.length,
    intersectingCount: intersecting.length,
  };
}
