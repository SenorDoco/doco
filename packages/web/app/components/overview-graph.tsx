import { Handle, type MiniMapNodeProps, Position } from "@xyflow/react";
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { NodeBadgeRow, ReferenceNumberBadge } from "~/components/neuron-badges";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { StandardControls, StandardMiniMap } from "~/components/perspective-canvas-overlays";
import {
  FAR_DEPTH,
  computeDepthFromCenter,
  depthBucket,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import { lifecycleColor } from "~/lib/neuron-colors";
import { overviewNodeDisplayLabel } from "~/lib/overview-graph-labels";
import { usePerspectiveReferences } from "~/lib/perspective-references";
import { useNewNodeIds } from "~/lib/use-new-neuron-ids";
import { selectRenderWindow } from "~/lib/viewport-render-window";
import "@xyflow/react/dist/style.css";

export interface OverviewGraphNode {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href?: string | null;
  is_center?: boolean;
}

export interface OverviewGraphLink {
  source: string;
  target: string;
  synapse_type: string;
}

export interface OverviewGraphData {
  centerId: string;
  nodes: OverviewGraphNode[];
  links: OverviewGraphLink[];
  detailUrl: string | null;
}

export interface OverviewNodeDetail {
  id: string;
  entity_type: string;
  summary: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href?: string | null;
}

interface OverviewGraphProps extends OverviewGraphData {
  fillHeight?: boolean;
  search?: ReactNode;
  onNeuronClick?: (node: OverviewGraphNode) => void;
  /**
   * Externally-controlled lifecycle visibility set. When provided, the
   * graph uses it as the source of truth; otherwise it manages state
   * internally. The filter UI itself lives on PerspectiveFrame; the
   * graph just receives the set so it can hide non-visible nodes.
   */
  visibleLifecycles?: Set<string>;
  /**
   * When the user clicks a neuron on the canvas, we want the graph
   * to re-center on it: depth-based opacity recomputes from the new
   * focal node and (if `autoReorder` is on) ordering re-runs so
   * first-degree neighbours sit closest. The parent owns `centerId`
   * state; this callback is how the canvas asks it to update.
   */
  onCenterChange?: (id: string) => void;
  /**
   * When true, layout places nodes in concentric rings by BFS depth
   * from the focal node — 1st-degree closest, then 2nd, then 3rd,
   * etc. When false, layout falls back to a single ring with
   * type-then-id ordering (the legacy behaviour). The "Reorder
   * automatically" toggle lives on PerspectiveFrame.
   */
  autoReorder?: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

interface OverviewNodeData {
  node: OverviewGraphNode;
  detail?: OverviewNodeDetail;
  showDetail: boolean;
  referenceNumber?: number;
  isNew: boolean;
  opacity: number;
}

// Canonical Lifecycle (@doco/shared) — four stages, in progression
// order.
const LIFECYCLE_ORDER = ["drafting", "proposed", "active", "retired"];
const HIDDEN_LIFECYCLES_BY_DEFAULT = new Set(["retired"]);
const NODE_TYPE_ORDER = new Map(
  [
    "principal",
    "intent",
    "decision",
    "action",
    "rule",
    "guidance_policy",
    "neuron_authoring_policy",
    "log",
    "eval",
    "reference",
    "idea",
    "state",
  ].map((type, index) => [type, index]),
);

// Card size — wide and tall enough to fit the badge row plus a few
// lines of title/summary. 336x136 (the previous bump) felt oversized,
// so this is 33% smaller in both dimensions per user feedback while
// keeping the card-shaped read.
const OVERVIEW_NODE_WIDTH = 224;
const OVERVIEW_NODE_HEIGHT = 91;
const DETAIL_ZOOM = 0.95;
const MAX_DETAIL_FETCH = 80;
const GRAPH_MIN_ZOOM = 0.03;
const GRAPH_MAX_ZOOM = 2.5;
const GRAPH_FIT_VIEW_OPTIONS = { padding: 0.12, maxZoom: 1.2 };
const OVERVIEW_RENDER_NODE_BUDGET = 600;
const OVERVIEW_RENDER_EDGE_BUDGET = 1200;
const OVERVIEW_RENDER_OVERSCAN_PX = 700;
const OVERVIEW_BOUNDS_NODE_ID = "__overview-layout-bounds__";

function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replaceAll("_", " ");
}

function nodeLifecycle(node: { lifecycle: string | null }): string {
  return node.lifecycle ?? "active";
}

/**
 * Lay out `others` in a ring at `radius` around `center`, sorted by
 * entity type then id so the placement is stable across renders.
 */
function placeRing(
  positions: Map<string, Point>,
  others: OverviewGraphNode[],
  center: Point,
  radius: number,
  startAngle: number,
) {
  if (others.length === 0) return;
  others.sort((a, b) => {
    const ai = NODE_TYPE_ORDER.get(a.entity_type) ?? 999;
    const bi = NODE_TYPE_ORDER.get(b.entity_type) ?? 999;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
  others.forEach((node, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / others.length;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });
}

/**
 * Single-ring layout — every non-focal node goes on the same ring,
 * sorted by type then id. Used when the user has disabled
 * "Reorder automatically" so neighbours stop migrating between rings
 * as they click around.
 */
function singleRingLayout(nodes: OverviewGraphNode[], centerId: string): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const center: Point = { x: 0, y: 0 };
  const others: OverviewGraphNode[] = [];
  let hasCenter = false;
  for (const node of nodes) {
    if (node.id === centerId) {
      positions.set(node.id, center);
      hasCenter = true;
    } else {
      others.push(node);
    }
  }

  if (others.length === 0) {
    if (!hasCenter) {
      const first = nodes[0];
      if (first) positions.set(first.id, center);
    }
    return positions;
  }

  const radius = Math.max(220, others.length * 18);
  placeRing(positions, others, center, radius, -Math.PI / 2);
  return positions;
}

/**
 * Depth-aware concentric-ring layout. Nodes are grouped into rings by
 * their BFS depth from the focal node — first-degree neighbours go on
 * the innermost ring, second-degree on the next, and so on. Anything
 * 4+ hops or unreachable shares the outermost ring (matching the
 * opacity ramp).
 *
 * Each ring's radius grows with both its depth and the count of nodes
 * it has to hold, so dense rings don't crowd themselves.
 */
function depthRingLayout(
  nodes: OverviewGraphNode[],
  links: OverviewGraphLink[],
  centerId: string,
): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const center: Point = { x: 0, y: 0 };
  let hasCenter = false;
  for (const node of nodes) {
    if (node.id === centerId) {
      positions.set(node.id, center);
      hasCenter = true;
    }
  }

  if (!hasCenter) {
    return singleRingLayout(nodes, centerId);
  }

  const depths = computeDepthFromCenter(nodes, links, centerId);
  const byBucket = new Map<number, OverviewGraphNode[]>();
  for (const node of nodes) {
    if (node.id === centerId) continue;
    const bucket = depthBucket(depths.get(node.id));
    const list = byBucket.get(bucket) ?? [];
    list.push(node);
    byBucket.set(bucket, list);
  }

  // Inner ring sits at the same baseline radius the old single-ring
  // layout used so the look of unfocused docos doesn't change.
  const BASE_RADIUS = 220;
  const RING_SPACING = 180;
  for (let bucket = 1; bucket <= FAR_DEPTH; bucket++) {
    const ring = byBucket.get(bucket);
    if (!ring || ring.length === 0) continue;
    const baseRadius = BASE_RADIUS + (bucket - 1) * RING_SPACING;
    // Crowd-protect dense rings by stretching the radius outwards.
    const radius = Math.max(baseRadius, ring.length * 18 + (bucket - 1) * RING_SPACING);
    // Stagger the starting angle by bucket so neighbouring rings
    // don't line up radially and edges read cleanly.
    const startAngle = -Math.PI / 2 + (bucket % 2 === 0 ? Math.PI / ring.length : 0);
    placeRing(positions, ring, center, radius, startAngle);
  }

  return positions;
}

function layoutNodes(
  nodes: OverviewGraphNode[],
  links: OverviewGraphLink[],
  centerId: string,
  autoReorder: boolean,
): Map<string, Point> {
  return autoReorder ? depthRingLayout(nodes, links, centerId) : singleRingLayout(nodes, centerId);
}

function isVisibleInViewport(
  position: Point,
  viewport: FlowViewport,
  size: { width: number; height: number },
): boolean {
  const x = position.x * viewport.zoom + viewport.x;
  const y = position.y * viewport.zoom + viewport.y;
  return (
    x > -OVERVIEW_NODE_WIDTH * 2 &&
    y > -OVERVIEW_NODE_HEIGHT * 2 &&
    x < size.width + OVERVIEW_NODE_WIDTH * 2 &&
    y < size.height + OVERVIEW_NODE_HEIGHT * 2
  );
}

function screenPosition(position: Point, viewport: FlowViewport): Point {
  return {
    x: position.x * viewport.zoom + viewport.x,
    y: position.y * viewport.zoom + viewport.y,
  };
}

function lifecycleWindowRank(lifecycle: string | null): number {
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

function layoutBounds(positions: Map<string, Point>): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (positions.size === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const position of positions.values()) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + OVERVIEW_NODE_WIDTH);
    maxY = Math.max(maxY, position.y + OVERVIEW_NODE_HEIGHT);
  }
  const pad = Math.max(OVERVIEW_NODE_WIDTH, OVERVIEW_NODE_HEIGHT);
  return {
    x: minX - pad,
    y: minY - pad,
    width: Math.max(1, maxX - minX + pad * 2),
    height: Math.max(1, maxY - minY + pad * 2),
  };
}

// MiniMap node component — mirrors the rounded-rectangle nodes drawn on
// the canvas, filled with the node's lifecycle color so the minimap is
// a true scaled silhouette rather than a uniform grid of beige boxes.
function makeOverviewMiniMapNode(
  nodeById: Map<string, OverviewGraphNode>,
): ComponentType<MiniMapNodeProps> {
  return function OverviewMiniMapNode({
    id,
    x,
    y,
    width,
    height,
    strokeColor,
    strokeWidth,
    className,
    selected,
    shapeRendering,
  }: MiniMapNodeProps) {
    const graphNode = nodeById.get(id);
    if (!graphNode) return null;
    const fill = lifecycleColor(nodeLifecycle(graphNode));
    const stroke = strokeColor ?? "rgba(0,0,0,0.5)";
    const sw = (strokeWidth ?? 1) * (graphNode.is_center ? 2 : 1);
    const radius = Math.min(width, height) / 3;
    const classes = ["react-flow__minimap-node", selected ? "selected" : "", className]
      .filter(Boolean)
      .join(" ");
    return (
      <g className={classes} shapeRendering={shapeRendering}>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={radius}
          ry={radius}
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
          style={{ vectorEffect: "non-scaling-stroke" }}
        />
      </g>
    );
  };
}

const HIDDEN_HANDLE_STYLE = {
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  background: "transparent",
  border: "none",
  pointerEvents: "none" as const,
  opacity: 0,
};

function OverviewFlowNode({ data }: { data: OverviewNodeData }) {
  const lifecycle = nodeLifecycle(data.node);
  const detail = data.detail;
  const title = overviewNodeDisplayLabel(data.node, detail);
  const summary = detail?.summary ?? null;
  const hasSummary = Boolean(summary) && summary !== title;

  return (
    <div className="relative h-full w-full overflow-visible" style={{ opacity: data.opacity }}>
      <div
        className={`neu-surface overview-graph-node nodrag nopan relative flex h-full w-full flex-col justify-center gap-1.5 overflow-hidden rounded-md border bg-white px-3 py-2 pl-4 text-left shadow-sm${data.isNew ? " doco-new-node-glow" : ""}`}
        data-graph-reference-number={data.referenceNumber ?? undefined}
        data-neuron-href={detail?.href ?? data.node.href ?? undefined}
        data-neuron-id={data.node.id}
        data-neuron-label={title}
        data-neuron-lifecycle={lifecycle}
        data-neuron-type={data.node.entity_type}
        data-overview-node-new={data.isNew ? "true" : undefined}
        style={{
          borderColor: data.node.is_center ? "var(--color-foreground)" : "var(--color-border)",
          borderLeft: `6px solid ${lifecycleColor(lifecycle)}`,
        }}
        title={title}
      >
        <Handle
          type="target"
          position={Position.Left}
          style={HIDDEN_HANDLE_STYLE}
          isConnectable={false}
        />
        <div className="flex items-center gap-2">
          <NeuronTypeIcon entityType={data.node.entity_type} className="!h-4 !w-4 shrink-0" />
          <span className="line-clamp-2 min-w-0 flex-1 font-mono text-xs font-semibold leading-snug text-foreground">
            {title}
          </span>
        </div>
        {hasSummary ? (
          <p className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">{summary}</p>
        ) : null}
        <Handle
          type="source"
          position={Position.Right}
          style={HIDDEN_HANDLE_STYLE}
          isConnectable={false}
        />
      </div>
      {/* Badges live OUTSIDE the bordered inner card div so they center
          against the outer wrapper's geometric box, not the inner
          padding-box (which is shifted right by the 6px left border —
          centers the badge ~3px right of the card's true middle). */}
      <NodeBadgeRow
        entityType={data.node.entity_type}
        lifecycle={lifecycle}
        className="nodrag nopan"
        interactive
      />
      <ReferenceNumberBadge referenceNumber={data.referenceNumber} referenceLabel={title} />
    </div>
  );
}

export function OverviewGraph({
  centerId,
  nodes,
  links,
  detailUrl,
  fillHeight = false,
  search,
  onNeuronClick,
  visibleLifecycles: externalVisibleLifecycles,
  onCenterChange,
  autoReorder = true,
}: OverviewGraphProps) {
  const navigate = useNavigate();
  const graphRef = useRef<HTMLDivElement>(null);
  const hasFitRef = useRef(false);
  // Cached React Flow instance plus the centerId most recently zoomed to.
  // The instance is captured in onInit; the effect below uses it to
  // animate the viewport when centerId changes — the singleRingLayout
  // re-runs and places the new focal at (0, 0), but the viewport
  // doesn't follow without this. Skipped on the first render because
  // the initial fitView already centers the canvas on the focal.
  type FlowFitView = (options?: {
    nodes?: { id: string }[];
    padding?: number;
    duration?: number;
    minZoom?: number;
    maxZoom?: number;
  }) => void;
  const flowRef = useRef<{ fitView?: FlowFitView } | null>(null);
  const lastZoomedCenterRef = useRef<string | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const [details, setDetails] = useState<Map<string, OverviewNodeDetail>>(() => new Map());
  const updateViewport = (next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  };

  const allLifecycles = useMemo(() => {
    const set = new Set<string>(["active"]);
    for (const node of nodes) set.add(nodeLifecycle(node));
    return Array.from(set).sort((a, b) => {
      const ai = LIFECYCLE_ORDER.indexOf(a);
      const bi = LIFECYCLE_ORDER.indexOf(b);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return a.localeCompare(b);
    });
  }, [nodes]);
  // When the caller passes a `visibleLifecycles` set, the graph is
  // "controlled" — external state wins and we don't render the
  // internal filter UI below. Otherwise we manage state locally
  // (legacy/uncontrolled).
  const controlledMode = externalVisibleLifecycles !== undefined;
  const [internalVisibleLifecycles, setVisibleLifecycles] = useState<Set<string>>(
    () =>
      new Set(allLifecycles.filter((lifecycle) => !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle))),
  );

  useEffect(() => {
    if (controlledMode) return;
    setVisibleLifecycles((prev) => {
      const next = new Set<string>();
      for (const lifecycle of allLifecycles) {
        if (prev.has(lifecycle) || !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle)) {
          next.add(lifecycle);
        }
      }
      return next;
    });
  }, [allLifecycles, controlledMode]);

  const visibleLifecycles = externalVisibleLifecycles ?? internalVisibleLifecycles;

  const visibleNodes = useMemo(
    () => nodes.filter((node) => visibleLifecycles.has(nodeLifecycle(node))),
    [nodes, visibleLifecycles],
  );

  // Auto-zoom: when centerId changes after the initial fit, animate the
  // viewport so the new focal node lands in the middle of the canvas.
  // Used by the agent's auto-focus flow (Señor Doco navigates to a
  // neuron → camera glides to it) and by manual clicks on a graph node
  // (which also bump centerId via onCenterChange). The rAF defers until
  // after React Flow has applied the layout's new positions, otherwise
  // fitView would target stale coordinates. No-op if React Flow hasn't
  // mounted, if it's the same centerId we already zoomed to, or if no
  // node with that id is present yet.
  useEffect(() => {
    if (!flowRef.current) return;
    if (lastZoomedCenterRef.current === centerId) return;
    if (!visibleNodes.some((n) => n.id === centerId)) return;
    lastZoomedCenterRef.current = centerId;
    const handle = requestAnimationFrame(() => {
      flowRef.current?.fitView?.({
        nodes: [{ id: centerId }],
        padding: 2,
        duration: 600,
        minZoom: 0.6,
        maxZoom: 1.4,
      });
    });
    return () => cancelAnimationFrame(handle);
  }, [centerId, visibleNodes]);

  // Diff against the full incoming `nodes` set, not `visibleNodes`, so
  // toggling a lifecycle filter back on doesn't glow nodes that have
  // been around the whole time.
  const allNodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const newNodeIds = useNewNodeIds(allNodeIds);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleLinks = useMemo(
    () => links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target)),
    [links, visibleIds],
  );
  const positions = useMemo(
    () => layoutNodes(visibleNodes, visibleLinks, centerId, autoReorder),
    [visibleNodes, visibleLinks, centerId, autoReorder],
  );
  const nodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  );
  const MiniMapNode = useMemo(() => makeOverviewMiniMapNode(nodeById), [nodeById]);
  const depthByNodeId = useMemo(
    () => computeDepthFromCenter(visibleNodes, visibleLinks, centerId),
    [visibleNodes, visibleLinks, centerId],
  );
  const focalActive = useMemo(() => hasFocalNode(centerId, visibleNodes), [centerId, visibleNodes]);
  const renderWindow = useMemo(
    () =>
      selectRenderWindow(
        visibleNodes.flatMap((node) => {
          const position = positions.get(node.id);
          if (!position) return [];
          const bucket = depthBucket(depthByNodeId.get(node.id));
          return [
            {
              id: node.id,
              x: position.x,
              y: position.y,
              width: OVERVIEW_NODE_WIDTH,
              height: OVERVIEW_NODE_HEIGHT,
              priority:
                node.id === centerId
                  ? 0
                  : bucket * 10 + lifecycleWindowRank(node.lifecycle) + (node.is_center ? 0 : 1),
            },
          ];
        }),
        {
          viewport,
          size,
          maxItems: OVERVIEW_RENDER_NODE_BUDGET,
          overscanPx: OVERVIEW_RENDER_OVERSCAN_PX,
          mustIncludeIds: [centerId],
        },
      ),
    [visibleNodes, positions, depthByNodeId, centerId, viewport, size],
  );
  const renderedNodeIds = renderWindow.ids;
  const renderedNodes = useMemo(
    () => visibleNodes.filter((node) => renderedNodeIds.has(node.id)),
    [visibleNodes, renderedNodeIds],
  );
  const renderedLinks = useMemo(() => {
    const candidates = visibleLinks
      .filter((link) => renderedNodeIds.has(link.source) && renderedNodeIds.has(link.target))
      .map((link, index) => ({ link, index }))
      .sort((a, b) => {
        const aDepth = Math.max(
          depthBucket(depthByNodeId.get(a.link.source)),
          depthBucket(depthByNodeId.get(a.link.target)),
        );
        const bDepth = Math.max(
          depthBucket(depthByNodeId.get(b.link.source)),
          depthBucket(depthByNodeId.get(b.link.target)),
        );
        if (aDepth !== bDepth) return aDepth - bDepth;
        const aTouchesCenter = a.link.source === centerId || a.link.target === centerId;
        const bTouchesCenter = b.link.source === centerId || b.link.target === centerId;
        if (aTouchesCenter !== bTouchesCenter) return aTouchesCenter ? -1 : 1;
        return a.index - b.index;
      });
    return candidates.slice(0, OVERVIEW_RENDER_EDGE_BUDGET).map((entry) => entry.link);
  }, [visibleLinks, renderedNodeIds, depthByNodeId, centerId]);
  const boundsNode = useMemo(() => layoutBounds(positions), [positions]);

  // Dynamic import — React Flow touches the DOM during module init.
  const [Flow, setFlow] = useState<null | typeof import("@xyflow/react")>(null);
  useEffect(() => {
    let canceled = false;
    import("@xyflow/react").then((mod) => {
      if (!canceled) setFlow(mod);
    });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const update = () =>
      setSize({ width: Math.max(1, el.clientWidth), height: Math.max(1, el.clientHeight) });
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const detailIds = useMemo(() => {
    if (viewport.zoom < DETAIL_ZOOM) return [];
    return renderedNodes
      .filter((node) => {
        const position = positions.get(node.id);
        return position ? isVisibleInViewport(position, viewport, size) : false;
      })
      .slice(0, MAX_DETAIL_FETCH)
      .map((node) => node.id)
      .filter((id) => !details.has(id));
  }, [renderedNodes, positions, viewport, size, details]);

  // Build reference candidates for the shared numbering hook. Each
  // candidate is one visible node carrying enough info to be sorted
  // (canvas-space position + dimensions) and labelled.
  //
  // We DON'T gate on detail being loaded — detail-fetch is gated by
  // DETAIL_ZOOM (0.95) and only fires when the user zooms in, so on
  // fresh load of a many-neuron Doco no details exist and badges
  // wouldn't appear until the user manually zoomed past 0.95.
  // `overviewNodeDisplayLabel` falls back to `node.name ?? node.id`
  // when detail is absent, and the href falls back to `node.href`.
  const referenceCandidates = useMemo(
    () =>
      renderedNodes.flatMap((node) => {
        const position = positions.get(node.id);
        if (!position) return [];
        const detail = details.get(node.id);
        return [
          {
            id: node.id,
            entity_type: node.entity_type,
            label: overviewNodeDisplayLabel(node, detail),
            lifecycle: node.lifecycle,
            href: detail?.href ?? node.href ?? null,
            position,
            width: OVERVIEW_NODE_WIDTH,
            height: OVERVIEW_NODE_HEIGHT,
          },
        ];
      }),
    [renderedNodes, details, positions],
  );
  const { numberById: referenceNumberByNodeId } = usePerspectiveReferences({
    source: "overview",
    viewport,
    size,
    candidates: referenceCandidates,
  });

  useEffect(() => {
    if (!detailUrl || detailIds.length === 0) return;
    const timeout = window.setTimeout(async () => {
      const url = new URL(detailUrl, window.location.origin);
      url.searchParams.set("ids", detailIds.join(","));
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const json = (await res.json()) as { nodes?: OverviewNodeDetail[] };
      setDetails((prev) => {
        const next = new Map(prev);
        for (const node of json.nodes ?? []) next.set(node.id, node);
        return next;
      });
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [detailUrl, detailIds]);

  const flowNodes = useMemo(() => {
    const rendered = renderedNodes.map((node) => {
      const position = positions.get(node.id) ?? { x: 0, y: 0 };
      const opacity = focalActive ? opacityForDepth(depthByNodeId.get(node.id)) : 1;
      return {
        id: node.id,
        type: "overviewNode",
        position,
        initialWidth: OVERVIEW_NODE_WIDTH,
        initialHeight: OVERVIEW_NODE_HEIGHT,
        data: {
          node,
          detail: details.get(node.id),
          showDetail: viewport.zoom >= DETAIL_ZOOM,
          referenceNumber: referenceNumberByNodeId.get(node.id),
          isNew: newNodeIds.has(node.id),
          opacity,
        } satisfies OverviewNodeData,
        draggable: false,
        selectable: false,
        connectable: false,
        style: {
          width: OVERVIEW_NODE_WIDTH,
          height: OVERVIEW_NODE_HEIGHT,
          padding: 0,
          background: "transparent",
          border: "none",
        },
      };
    });
    if (!boundsNode) return rendered;
    return [
      {
        id: OVERVIEW_BOUNDS_NODE_ID,
        position: { x: boundsNode.x, y: boundsNode.y },
        initialWidth: boundsNode.width,
        initialHeight: boundsNode.height,
        data: { label: null },
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        style: {
          width: boundsNode.width,
          height: boundsNode.height,
          opacity: 0,
          pointerEvents: "none" as const,
          background: "transparent",
          border: "none",
          padding: 0,
        },
      },
      ...rendered,
    ];
  }, [
    renderedNodes,
    positions,
    details,
    viewport.zoom,
    referenceNumberByNodeId,
    newNodeIds,
    depthByNodeId,
    focalActive,
    boundsNode,
  ]);

  const flowEdges = useMemo(
    () =>
      renderedLinks.map((link, index) => {
        const edgeOpacity = focalActive
          ? opacityForEdge(depthByNodeId.get(link.source), depthByNodeId.get(link.target))
          : 1;
        // Synapse inherits the origin neuron's lifecycle colour. 0.5 is
        // the baseline stroke alpha so coloured lines stay readable on
        // the pale canvas without competing with the node strokes.
        const sourceLifecycle = nodeById.get(link.source)?.lifecycle ?? "active";
        return {
          id: `${link.source}-${link.target}-${index}`,
          source: link.source,
          target: link.target,
          type: "default",
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          style: {
            stroke: lifecycleColor(sourceLifecycle),
            strokeOpacity: 0.5 * edgeOpacity,
            pointerEvents: "none" as const,
          },
        };
      }),
    [renderedLinks, depthByNodeId, focalActive, nodeById],
  );

  const nodeTypes = useMemo(() => ({ overviewNode: OverviewFlowNode }), []);

  return (
    <div className={fillHeight ? "flex h-full min-h-0 flex-col" : "flex flex-col"}>
      <div ref={graphRef} className="relative min-h-0 w-full flex-1 overflow-hidden">
        {search ? (
          <div className="nodrag nopan absolute left-3 top-3 z-20 w-64 max-w-[calc(100%-9rem)]">
            {search}
          </div>
        ) : null}
        {visibleNodes.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center text-center text-sm font-medium text-muted-foreground">
            So empty
          </div>
        ) : Flow ? (
          <Flow.ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            onlyRenderVisibleElements
            fitView
            fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
            minZoom={GRAPH_MIN_ZOOM}
            maxZoom={GRAPH_MAX_ZOOM}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick
            preventScrolling
            onInit={(instance: {
              fitView?: FlowFitView;
              getViewport?: () => FlowViewport;
            }) => {
              flowRef.current = instance;
              if (!hasFitRef.current) {
                instance.fitView?.(GRAPH_FIT_VIEW_OPTIONS);
                hasFitRef.current = true;
                lastZoomedCenterRef.current = centerId;
              }
              const next = instance.getViewport?.();
              if (next) updateViewport(next);
            }}
            onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
            onNodeClick={(_event: unknown, node: { id: string }) => {
              const target = nodeById.get(node.id);
              // Re-center the canvas on the clicked neuron so the
              // depth-based fading + (optionally) the depth-aware
              // layout both recompute from the new focal node. The
              // dialog still opens via onNeuronClick below — those
              // two behaviours are independent.
              if (target && onCenterChange) onCenterChange(target.id);
              if (target && onNeuronClick) {
                onNeuronClick(target);
                return;
              }
              if (target?.href) navigate(target.href);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Flow.Background gap={20} size={1} />
            <StandardControls fitViewOptions={GRAPH_FIT_VIEW_OPTIONS} />
            <StandardMiniMap nodeComponent={MiniMapNode} />
          </Flow.ReactFlow>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Loading graph…
          </div>
        )}
        {/* PerspectiveFrame owns the lifecycle filter, the
            "Reorder automatically" toggle, and the fullscreen button.
            They render at fixed positions across every perspective.
            Graph just receives `autoReorder` + `visibleLifecycles` as
            data and applies them to its layout / node filter. */}
      </div>
    </div>
  );
}
