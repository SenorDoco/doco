export type GraphRenderPerspective = "graph" | "bpmn";

export interface GraphRenderBudgetRequest {
  perspective: GraphRenderPerspective;
  nodeCount: number;
  linkCount: number;
}

export interface GraphRenderBudget {
  nodeBudget: number;
  minFirstDegree: number;
  edgeBudget: number;
  placeholderStubBudget: number;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

interface ViewportPublishOptions {
  panThresholdPx?: number;
  zoomThreshold?: number;
}

const COMPLETE_RENDER_BUDGET: GraphRenderBudget = {
  nodeBudget: 100,
  minFirstDegree: 50,
  edgeBudget: 700,
  placeholderStubBudget: 120,
};

const DENSE_RENDER_BUDGET: GraphRenderBudget = {
  nodeBudget: 64,
  minFirstDegree: 32,
  edgeBudget: 220,
  placeholderStubBudget: 72,
};

const DENSE_RENDER_BUDGET_BY_PERSPECTIVE: Record<GraphRenderPerspective, GraphRenderBudget> = {
  graph: DENSE_RENDER_BUDGET,
  bpmn: DENSE_RENDER_BUDGET,
};

const DENSE_NODE_THRESHOLD = 80;
const DENSE_EDGE_THRESHOLD = 240;
const DEFAULT_PAN_THRESHOLD_PX = 8;
const DEFAULT_ZOOM_THRESHOLD = 0.01;

function finiteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function graphRenderBudgetFor({
  perspective,
  nodeCount,
  linkCount,
}: GraphRenderBudgetRequest): GraphRenderBudget {
  const nodes = finiteCount(nodeCount);
  const links = finiteCount(linkCount);
  const denseBudget = DENSE_RENDER_BUDGET_BY_PERSPECTIVE[perspective];

  if (nodes >= DENSE_NODE_THRESHOLD || links >= DENSE_EDGE_THRESHOLD) {
    return denseBudget;
  }
  return COMPLETE_RENDER_BUDGET;
}

export function shouldPublishViewport(
  previous: GraphViewport,
  next: GraphViewport,
  options: ViewportPublishOptions = {},
): boolean {
  if (
    !Number.isFinite(previous.x + previous.y + previous.zoom) ||
    !Number.isFinite(next.x + next.y + next.zoom)
  ) {
    return true;
  }

  const panThresholdPx = options.panThresholdPx ?? DEFAULT_PAN_THRESHOLD_PX;
  const zoomThreshold = options.zoomThreshold ?? DEFAULT_ZOOM_THRESHOLD;

  return (
    Math.abs(next.x - previous.x) >= panThresholdPx ||
    Math.abs(next.y - previous.y) >= panThresholdPx ||
    Math.abs(next.zoom - previous.zoom) >= zoomThreshold
  );
}
