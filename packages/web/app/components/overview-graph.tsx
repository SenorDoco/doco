import {
  type Edge,
  Handle,
  MarkerType,
  type MiniMapNodeProps,
  type Node,
  Position,
} from "@xyflow/react";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { FadingPlaceholderEdge } from "~/components/fading-placeholder-edge";
import { NodeBadgeRow, ReferenceNumberBadge } from "~/components/neuron-badges";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { StandardControls, StandardMiniMap } from "~/components/perspective-canvas-overlays";
import { StreetBezierEdge } from "~/components/stable-labeled-edge";
import {
  highestRankedNodeId,
  selectMeasuredPersonalizedNodeIds,
  summarizeExternalConnections,
} from "~/lib/focused-render-selection";
import {
  computeDepthFromCenter,
  depthBucket,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import { lifecycleColor } from "~/lib/neuron-colors";
import { overviewNodeDisplayLabel } from "~/lib/overview-graph-labels";
import { type Point, layoutOverviewGraphNodes } from "~/lib/overview-graph-layout";
import { usePerspectiveReferences } from "~/lib/perspective-references";
import { useBufferedRenderedIds } from "~/lib/use-buffered-rendered-ids";
import { useNewNodeIds } from "~/lib/use-new-neuron-ids";
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
  label?: string | null;
}

export interface OverviewGraphData {
  centerId: string;
  nodes: OverviewGraphNode[];
  links: OverviewGraphLink[];
  detailUrl: string | null;
  pageRanks?: Map<string, number>;
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
  docoHandle?: string | null;
  fillHeight?: boolean;
  search?: ReactNode;
  /**
   * One-shot viewport instruction used when the page opens directly
   * on a neuron URL. Unlike click focus, this should center the node
   * at 100% zoom instead of fitting the whole graph.
   */
  initialFocusId?: string | null;
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
   * When true, layout uses a weighted clustered solver so linked
   * neurons can settle near each other without collapsing into depth
   * rings. When false, layout falls back to a single stable ring with
   * type-then-id ordering. The "Reorder automatically" toggle lives
   * on PerspectiveFrame.
   */
  autoReorder?: boolean;
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
const OVERVIEW_RENDER_NODE_BUDGET = 20;
const OVERVIEW_RENDER_EDGE_BUDGET = 700;
const OVERVIEW_PLACEHOLDER_STUB_BUDGET = 120;
const OVERVIEW_PLACEHOLDER_STUB_DISTANCE_PX = 252;
const OVERVIEW_PLACEHOLDER_STUB_DISTANCE_JITTER_PX = 24;
const OVERVIEW_PLACEHOLDER_EDGE_FADE_PX = 200;
const OVERVIEW_INCOMING_MARKER_CLEARANCE_PX = 2;

function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replaceAll("_", " ");
}

function nodeLifecycle(node: { lifecycle: string | null }): string {
  return node.lifecycle ?? "active";
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
    const sw = graphNode.is_center ? (strokeWidth ?? 1) * 2 : (strokeWidth ?? 1);
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

function EdgeStubNode() {
  return (
    <div style={{ width: 1, height: 1, opacity: 0 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={HIDDEN_HANDLE_STYLE}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={HIDDEN_HANDLE_STYLE}
        isConnectable={false}
      />
    </div>
  );
}

function OverviewFlowNode({ data }: { data: OverviewNodeData }) {
  const lifecycle = nodeLifecycle(data.node);
  const detail = data.detail;
  const title = overviewNodeDisplayLabel(data.node, detail);
  const summary = detail?.summary ?? null;
  const hasSummary = Boolean(summary) && summary !== title;

  return (
    <div className="relative h-full w-full overflow-visible" style={{ opacity: data.opacity }}>
      <Handle
        type="target"
        position={Position.Left}
        style={HIDDEN_HANDLE_STYLE}
        isConnectable={false}
      />
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
          borderWidth: data.node.is_center ? 2 : 1,
          borderLeft: `6px solid ${lifecycleColor(lifecycle)}`,
        }}
        title={title}
      >
        <div className="flex items-center gap-2">
          <NeuronTypeIcon entityType={data.node.entity_type} className="!h-4 !w-4 shrink-0" />
          <span className="line-clamp-2 min-w-0 flex-1 font-mono text-xs font-semibold leading-snug text-foreground">
            {title}
          </span>
        </div>
        {hasSummary ? (
          <p className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">{summary}</p>
        ) : null}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={HIDDEN_HANDLE_STYLE}
        isConnectable={false}
      />
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
  docoHandle,
  centerId,
  nodes,
  links,
  detailUrl,
  pageRanks,
  fillHeight = false,
  search,
  initialFocusId,
  onNeuronClick,
  visibleLifecycles: externalVisibleLifecycles,
  onCenterChange,
  autoReorder = true,
}: OverviewGraphProps) {
  const navigate = useNavigate();
  const graphRef = useRef<HTMLDivElement>(null);
  const hasFitRef = useRef(false);
  type FlowFitView = (options?: {
    nodes?: { id: string }[];
    padding?: number;
    duration?: number;
    minZoom?: number;
    maxZoom?: number;
  }) => void;
  type FlowInstance = {
    fitView?: FlowFitView;
    getViewport?: () => FlowViewport;
  };
  const positionCacheRef = useRef<Map<string, Point>>(new Map());
  const positionCacheKeyRef = useRef(autoReorder);
  const flowInstanceRef = useRef<FlowInstance | null>(null);
  const initialFocusAppliedRef = useRef<string | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const [details, setDetails] = useState<Map<string, OverviewNodeDetail>>(() => new Map());
  const updateViewport = useCallback((next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  }, []);

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

  const effectiveCenterId = useMemo(() => {
    if (visibleNodes.some((node) => node.id === centerId)) return centerId;
    return highestRankedNodeId(visibleNodes, pageRanks) ?? centerId;
  }, [visibleNodes, centerId, pageRanks]);

  useEffect(() => {
    if (!effectiveCenterId || effectiveCenterId === centerId) return;
    onCenterChange?.(effectiveCenterId);
  }, [effectiveCenterId, centerId, onCenterChange]);

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
  const visibleDepthByNodeId = useMemo(
    () => computeDepthFromCenter(visibleNodes, visibleLinks, effectiveCenterId),
    [visibleNodes, visibleLinks, effectiveCenterId],
  );
  const targetRenderedNodeIds = useMemo(
    () =>
      selectMeasuredPersonalizedNodeIds(
        visibleNodes,
        visibleLinks,
        effectiveCenterId,
        pageRanks,
        OVERVIEW_RENDER_NODE_BUDGET,
        { docoHandle, perspective: "graph" },
      ),
    [visibleNodes, visibleLinks, effectiveCenterId, pageRanks, docoHandle],
  );
  const renderedNodeIds = useBufferedRenderedIds(targetRenderedNodeIds, visibleIds);
  const renderedNodes = useMemo(
    () =>
      visibleNodes
        .filter((node) => renderedNodeIds.has(node.id))
        .map((node) => ({ ...node, is_center: node.id === effectiveCenterId })),
    [visibleNodes, renderedNodeIds, effectiveCenterId],
  );
  const renderedLinks = useMemo(() => {
    const candidates = visibleLinks
      .filter((link) => renderedNodeIds.has(link.source) && renderedNodeIds.has(link.target))
      .map((link, index) => ({ link, index }))
      .sort((a, b) => {
        const aDepth = Math.max(
          depthBucket(visibleDepthByNodeId.get(a.link.source)),
          depthBucket(visibleDepthByNodeId.get(a.link.target)),
        );
        const bDepth = Math.max(
          depthBucket(visibleDepthByNodeId.get(b.link.source)),
          depthBucket(visibleDepthByNodeId.get(b.link.target)),
        );
        if (aDepth !== bDepth) return aDepth - bDepth;
        const aTouchesCenter =
          a.link.source === effectiveCenterId || a.link.target === effectiveCenterId;
        const bTouchesCenter =
          b.link.source === effectiveCenterId || b.link.target === effectiveCenterId;
        if (aTouchesCenter !== bTouchesCenter) return aTouchesCenter ? -1 : 1;
        const aRank = Math.max(
          pageRanks?.get(a.link.source) ?? 0,
          pageRanks?.get(a.link.target) ?? 0,
        );
        const bRank = Math.max(
          pageRanks?.get(b.link.source) ?? 0,
          pageRanks?.get(b.link.target) ?? 0,
        );
        if (aRank !== bRank) return bRank - aRank;
        return a.index - b.index;
      });
    return candidates.slice(0, OVERVIEW_RENDER_EDGE_BUDGET).map((entry) => entry.link);
  }, [visibleLinks, renderedNodeIds, visibleDepthByNodeId, effectiveCenterId, pageRanks]);
  if (positionCacheKeyRef.current !== autoReorder) {
    positionCacheRef.current = new Map();
    positionCacheKeyRef.current = autoReorder;
  }
  const positions = useMemo(() => {
    const computed = layoutOverviewGraphNodes(
      renderedNodes,
      renderedLinks,
      effectiveCenterId,
      autoReorder,
    );
    const cache = positionCacheRef.current;
    const computedFocus = effectiveCenterId ? computed.get(effectiveCenterId) : undefined;
    const cachedFocus = effectiveCenterId ? cache.get(effectiveCenterId) : undefined;
    const offset =
      computedFocus && cachedFocus
        ? { x: cachedFocus.x - computedFocus.x, y: cachedFocus.y - computedFocus.y }
        : { x: 0, y: 0 };
    const visiblePositions = new Map<string, Point>();
    for (const node of renderedNodes) {
      const cached = cache.get(node.id);
      if (cached) {
        visiblePositions.set(node.id, cached);
        continue;
      }
      const next = computed.get(node.id) ?? { x: 0, y: 0 };
      const shifted = { x: next.x + offset.x, y: next.y + offset.y };
      cache.set(node.id, shifted);
      visiblePositions.set(node.id, shifted);
    }
    return visiblePositions;
  }, [renderedNodes, renderedLinks, effectiveCenterId, autoReorder]);
  const nodeById = useMemo(
    () => new Map(renderedNodes.map((node) => [node.id, node])),
    [renderedNodes],
  );
  const visibleNodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  );
  const MiniMapNode = useMemo(() => makeOverviewMiniMapNode(nodeById), [nodeById]);
  const depthByNodeId = useMemo(
    () => computeDepthFromCenter(renderedNodes, renderedLinks, effectiveCenterId),
    [renderedNodes, renderedLinks, effectiveCenterId],
  );
  const focalActive = useMemo(
    () => hasFocalNode(effectiveCenterId, renderedNodes),
    [effectiveCenterId, renderedNodes],
  );

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

  const externalEdgeStubs = useMemo(() => {
    const summaries = summarizeExternalConnections(visibleLinks, renderedNodeIds, visibleIds);
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    let stubIndex = 0;

    const addStub = (
      anchorId: string,
      direction: "incoming" | "outgoing",
      count: number,
      summaryIndex: number,
    ) => {
      if (stubIndex >= OVERVIEW_PLACEHOLDER_STUB_BUDGET) return;
      const anchor = positions.get(anchorId);
      if (!anchor) return;
      const anchorCenter = {
        x: anchor.x + OVERVIEW_NODE_WIDTH / 2,
        y: anchor.y + OVERVIEW_NODE_HEIGHT / 2,
      };
      const directionSign = direction === "incoming" ? -1 : 1;
      const distance =
        OVERVIEW_PLACEHOLDER_STUB_DISTANCE_PX +
        (summaryIndex % 3) * OVERVIEW_PLACEHOLDER_STUB_DISTANCE_JITTER_PX;
      const id = `overview-placeholder:${direction}:${anchorId}`;
      const position = {
        x: anchorCenter.x + directionSign * distance,
        y: anchorCenter.y,
      };
      const matchingLink = visibleLinks.find((link) =>
        direction === "incoming"
          ? link.target === anchorId && !renderedNodeIds.has(link.source)
          : link.source === anchorId && !renderedNodeIds.has(link.target),
      );
      const colorNode =
        direction === "incoming"
          ? visibleNodeById.get(matchingLink?.source ?? "")
          : visibleNodeById.get(anchorId);
      const stroke = lifecycleColor(colorNode ? nodeLifecycle(colorNode) : "active");

      nodes.push({
        id,
        type: "edgeStub",
        position,
        data: {},
        draggable: false,
        selectable: false,
        connectable: false,
        initialWidth: 1,
        initialHeight: 1,
        style: {
          width: 1,
          height: 1,
          opacity: 0,
          padding: 0,
          pointerEvents: "none" as const,
        },
      });
      edges.push({
        id: `overview-placeholder-edge:${direction}:${anchorId}`,
        source: direction === "incoming" ? id : anchorId,
        target: direction === "incoming" ? anchorId : id,
        type: "fadingPlaceholder",
        data: {
          color: stroke,
          direction,
          fadePx: OVERVIEW_PLACEHOLDER_EDGE_FADE_PX,
          markerClearancePx: OVERVIEW_INCOMING_MARKER_CLEARANCE_PX,
          opacity: 0.5,
        },
        selectable: false,
        focusable: false,
        interactionWidth: 0,
        style: {
          pointerEvents: "none" as const,
        },
        markerEnd:
          direction === "incoming"
            ? {
                type: MarkerType.ArrowClosed,
                width: 14,
                height: 14,
                color: stroke,
              }
            : undefined,
      });
      stubIndex++;
    };

    summaries.forEach((summary, index) => {
      if (summary.outgoing > 0) addStub(summary.id, "outgoing", summary.outgoing, index);
      if (summary.incoming > 0) addStub(summary.id, "incoming", summary.incoming, index);
    });

    return { nodes, edges };
  }, [visibleLinks, renderedNodeIds, visibleIds, positions, visibleNodeById]);

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
    const neuronNodes = renderedNodes.map((node) => {
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
    return [...neuronNodes, ...externalEdgeStubs.nodes];
  }, [
    renderedNodes,
    positions,
    details,
    viewport.zoom,
    referenceNumberByNodeId,
    newNodeIds,
    depthByNodeId,
    focalActive,
    externalEdgeStubs.nodes,
  ]);

  const flowEdges = useMemo(() => {
    const neuronEdges = renderedLinks.map((link, index) => {
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
        type: "streetBezier",
        selectable: false,
        focusable: false,
        interactionWidth: 0,
        style: {
          stroke: lifecycleColor(sourceLifecycle),
          strokeOpacity: 0.5 * edgeOpacity,
          pointerEvents: "none" as const,
        },
      };
    });
    return [...neuronEdges, ...externalEdgeStubs.edges];
  }, [renderedLinks, depthByNodeId, focalActive, nodeById, externalEdgeStubs.edges]);

  const nodeTypes = useMemo(() => ({ overviewNode: OverviewFlowNode, edgeStub: EdgeStubNode }), []);
  const edgeTypes = useMemo(
    () => ({ fadingPlaceholder: FadingPlaceholderEdge, streetBezier: StreetBezierEdge }),
    [],
  );
  const initialFocusFlowNodeId = useMemo(() => {
    if (!initialFocusId) return null;
    return flowNodes.some((node) => node.id === initialFocusId) ? initialFocusId : null;
  }, [flowNodes, initialFocusId]);

  useEffect(() => {
    if (!initialFocusFlowNodeId) return;
    if (initialFocusAppliedRef.current === initialFocusFlowNodeId) return;
    const instance = flowInstanceRef.current;
    if (!instance?.fitView) return;
    const frame = requestAnimationFrame(() => {
      instance.fitView?.({
        nodes: [{ id: initialFocusFlowNodeId }],
        padding: 0,
        minZoom: 1,
        maxZoom: 1,
        duration: 0,
      });
      const next = instance.getViewport?.();
      if (next) updateViewport(next);
      initialFocusAppliedRef.current = initialFocusFlowNodeId;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialFocusFlowNodeId, updateViewport]);

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
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            onlyRenderVisibleElements
            fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
            minZoom={GRAPH_MIN_ZOOM}
            maxZoom={GRAPH_MAX_ZOOM}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick
            preventScrolling
            onInit={(instance: FlowInstance) => {
              flowInstanceRef.current = instance;
              if (!hasFitRef.current) {
                if (initialFocusFlowNodeId) {
                  instance.fitView?.({
                    nodes: [{ id: initialFocusFlowNodeId }],
                    padding: 0,
                    minZoom: 1,
                    maxZoom: 1,
                    duration: 0,
                  });
                  initialFocusAppliedRef.current = initialFocusFlowNodeId;
                } else {
                  instance.fitView?.(GRAPH_FIT_VIEW_OPTIONS);
                }
                hasFitRef.current = true;
              }
              const next = instance.getViewport?.();
              if (next) updateViewport(next);
            }}
            onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
            onNodeClick={(_event: unknown, node: { id: string }) => {
              const target = nodeById.get(node.id);
              // Change focus without asking React Flow to refit the
              // viewport. Existing node coordinates stay pinned by
              // positionCacheRef; the render window may add/remove
              // nodes around the new focus.
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
