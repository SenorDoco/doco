// Entity-detail graph view (ADR-076, swapped to react-flow per ADR-113).
// Each node shows: type · title · how-long-ago · personalized PageRank.
// Global PageRank is a follow-up (needs a separate globalPageRank function
// in @doco/index — `personalizedPageRank` requires a single source).
//
// Layout: swim lanes by Principal, with Dagre left-to-right ordering
// (decision_01KRRJTW39THBW0C943G0GTH0M) inside each lane so process-shaped
// neighborhoods still read as BPMN flows.
//
// react-flow is loaded via dynamic import — it touches the DOM directly,
// can't run during SSR.
import dagre from "@dagrejs/dagre";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import {
  type GraphReferenceItem,
  clearGraphReferences,
  publishGraphReferences,
} from "~/lib/graph-references";
import { lifecycleColor } from "~/lib/neuron-colors";
import { useNewNodeIds } from "~/lib/use-new-neuron-ids";
import "@xyflow/react/dist/style.css";

/**
 * Administrative edge types that carry no reading value in the rendered
 * graph and clutter every neighborhood. Filtered out at render time
 * (decision_01KRRJTW39THBW0C943G0GTH0M). The underlying synapses remain in
 * the index — this is a visualization-only filter.
 *
 * Note: `created_by` / `updated_by` used to be filtered here. They're now
 * skipped at index time (see SKIP_FIELDS in packages/index/src/synapses.ts),
 * so the runtime filter is just for legacy synapses still sitting in the DB
 * from before the change.
 */
const ALWAYS_HIDDEN_EDGE_TYPES: ReadonlySet<string> = new Set(["created_by", "updated_by"]);

export interface GraphNode {
  id: string;
  entity_type: string;
  summary: string;
  /** Display name; not all entity types populate this. */
  name: string | null;
  /** Optional direct URL for aggregate/virtual graph nodes. */
  href?: string;
  /** Aggregate nodes render their covered entity count instead of rank. */
  count?: number;
  lifecycle?: string | null;
  /** Principal who owns this node's lane in the rendered graph. */
  collaborator_id?: string | null;
  principal_label?: string | null;
  created_at: string | null;
  /**
   * When the node last entered its CURRENT lifecycle. Pulled from the
   * audit log; falls back to `created_at` when no lifecycle change is
   * recorded. Cards render "X ago" using this value so the time
   * reflects how long the node has held its current state.
   */
  lifecycle_since?: string | null;
  /** Personalized PageRank from the focal node (1.0 = focal node itself). */
  ppr: number;
  /** Global PageRank — uniform-restart PR over the whole Doco graph. */
  gpr: number;
  is_center?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
  synapse_type: string;
}

interface EntityGraphProps {
  centerId: string;
  nodes: GraphNode[];
  links: GraphLink[];
  hrefFor?: (id: string, entityType: string) => string;
  /**
   * Entity-detail pages use principal swim lanes. Collection overview graphs
   * can render compact ranked grids or semantic clusters.
   */
  layoutMode?: "swimlanes" | "grid" | "cluster";
  /**
   * Entity-detail graphs have a meaningful focal node, so PPR is useful.
   * Collection graphs do not; they show global rank only.
   */
  showPersonalizedRank?: boolean;
  /**
   * When true, the wrapper becomes `h-full flex flex-col` and the inner
   * graph container drops its fixed `h-[65vh]` for `flex-1` so the graph
   * fills whatever vertical space its parent gives it. Used by the
   * non-scrollable node view.
   */
  fillHeight?: boolean;
}

interface MiniMapNodeProps {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style?: CSSProperties;
  selected?: boolean;
  className?: string;
  color?: string;
  strokeColor?: string;
  borderRadius?: number;
  shapeRendering?: string;
}

interface GraphLane {
  id: string;
  principalId: string | null;
  label: string;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GraphLayout {
  positions: Map<string, { x: number; y: number }>;
  lanes: GraphLane[];
}

interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

interface GraphSize {
  width: number;
  height: number;
}

// Canonical Lifecycle (@doco/shared) — four stages, in progression
// order.
const LIFECYCLE_ORDER = ["drafted", "proposed", "active", "retired"];

const HIDDEN_LIFECYCLES_BY_DEFAULT = new Set(["retired"]);

function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replaceAll("_", " ");
}

function nodeLifecycle(node: GraphNode): string {
  return node.lifecycle ?? "active";
}

const UNKNOWN_PRINCIPAL_KEY = "__unknown_principal__";
const UNKNOWN_PRINCIPAL_LABEL = "Unknown principal";

function principalLaneFor(node: GraphNode): { key: string; id: string | null; label: string } {
  if (node.entity_type === "principal") {
    return {
      key: node.id,
      id: node.id,
      label: node.name ?? node.summary ?? node.id,
    };
  }

  if (node.collaborator_id) {
    return {
      key: node.collaborator_id,
      id: node.collaborator_id,
      label: node.principal_label ?? node.collaborator_id,
    };
  }

  return { key: UNKNOWN_PRINCIPAL_KEY, id: null, label: UNKNOWN_PRINCIPAL_LABEL };
}

/** Format an ISO timestamp as "Ns / Nm / Nh / Nd ago". */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const deltaMs = Date.now() - t;
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Swim-lane graph layout: Principal controls the horizontal lane, while
 * Dagre's left-to-right rank controls ordering inside each lane.
 *
 * Process-shaped data (Intent + Actions chained via `follows` + Decisions
 * via `decision_ids`) keeps the same left-to-right reading order, but lanes
 * make ownership / authorship scannable before the viewer reads card copy.
 *
 * Edges that don't carry process / reasoning value (`created_by`,
 * `updated_by`) are filtered upstream so they don't influence the
 * layout.
 *
 * Returns positions keyed by node id, with the focal node centered at
 * (0, 0) so the existing `fitView` viewport math keeps working. Falls
 * back to the focal node only when Dagre cannot place a node (extreme
 * edge case — disconnected isolates).
 */
const NODE_WIDTH = 340;
const NODE_STRIPE_WIDTH = 24;
/**
 * Minimum card height. Cards with short content sit at this height;
 * cards whose summary needs more vertical room grow up to
 * `NODE_MAX_SUMMARY_LINES` lines.
 */
const NODE_HEIGHT = 132;
const NODE_MAX_SUMMARY_LINES = 8;
const NODE_GAP_X = 72;
const LANE_GAP = 28;
const LANE_HEADER_HEIGHT = 40;
const LANE_PADDING_X = 16;
const LANE_BOTTOM_PADDING = 20;
const GRID_GAP_X = 64;
const GRID_GAP_Y = 40;
const GRID_MIN_COLUMNS = 2;
const GRID_MAX_COLUMNS = 18;
const GRAPH_MIN_ZOOM = 0.02;
const GRAPH_FIT_VIEW_OPTIONS = { padding: 0.05, maxZoom: 1.6 };
const GRAPH_REFERENCE_ZOOM = 0.85;
const MAX_GRAPH_REFERENCES = 120;
const CLUSTER_CHILD_RADIUS = 190;
const GRID_TYPE_ORDER = new Map(
  [
    "intent",
    "decision",
    "action",
    "rule",
    "guidance_primitive",
    "neuron_authoring_primitive",
    "log",
    "eval",
    "reference",
    "idea",
    "state",
  ].map((type, index) => [type, index]),
);

/**
 * Estimate a card's rendered height from its summary length so the
 * graph layout can place lanes without cards overlapping into the lane
 * below. Conservative on purpose — better to leave a little slack than
 * to clip a card into its neighbor.
 */
function estimateCardHeight(summary: string, hasDistinctTitle: boolean): number {
  const charsPerLine = 32;
  const summaryLines = Math.max(
    1,
    Math.min(NODE_MAX_SUMMARY_LINES, Math.ceil((summary?.length ?? 0) / charsPerLine)),
  );
  const summaryHeight = summaryLines * 17;
  const headerHeight = 32;
  const titleHeight = hasDistinctTitle ? 22 : 0;
  const padding = 28;
  return Math.max(NODE_HEIGHT, headerHeight + titleHeight + summaryHeight + padding);
}

function nodeRenderHeight(node: GraphNode): number {
  const title = node.name ?? node.summary ?? "";
  const summary = node.summary ?? "";
  return estimateCardHeight(summary, title !== summary);
}

function screenPosition(position: { x: number; y: number }, viewport: FlowViewport) {
  return {
    x: position.x * viewport.zoom + viewport.x,
    y: position.y * viewport.zoom + viewport.y,
  };
}

function isNodeVisibleInViewport(
  position: { x: number; y: number },
  viewport: FlowViewport,
  size: GraphSize,
  height: number,
): boolean {
  const screen = screenPosition(position, viewport);
  const scaledWidth = NODE_WIDTH * viewport.zoom;
  const scaledHeight = height * viewport.zoom;
  return (
    screen.x > -scaledWidth &&
    screen.y > -scaledHeight &&
    screen.x < size.width + scaledWidth &&
    screen.y < size.height + scaledHeight
  );
}

function rankedGridLayout(nodes: GraphNode[]): GraphLayout {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return { positions, lanes: [] };

  const columns =
    nodes.length < GRID_MIN_COLUMNS
      ? nodes.length
      : Math.min(
          GRID_MAX_COLUMNS,
          Math.max(GRID_MIN_COLUMNS, Math.ceil(Math.sqrt(nodes.length * 1.35))),
        );
  const columnHeights = Array.from({ length: columns }, () => 0);
  const ordered = nodes.slice().sort((a, b) => {
    const ai = GRID_TYPE_ORDER.get(a.entity_type) ?? 999;
    const bi = GRID_TYPE_ORDER.get(b.entity_type) ?? 999;
    if (ai !== bi) return ai - bi;
    if ((b.gpr ?? 0) !== (a.gpr ?? 0)) return (b.gpr ?? 0) - (a.gpr ?? 0);
    return a.id.localeCompare(b.id);
  });

  const raw = new Map<string, { x: number; y: number }>();
  for (const node of ordered) {
    let column = 0;
    for (let i = 1; i < columnHeights.length; i++) {
      const candidateHeight = columnHeights[i] ?? 0;
      const currentHeight = columnHeights[column] ?? 0;
      if (candidateHeight < currentHeight) column = i;
    }
    const x = column * (NODE_WIDTH + GRID_GAP_X);
    const y = columnHeights[column] ?? 0;
    raw.set(node.id, { x, y });
    columnHeights[column] = y + nodeRenderHeight(node) + GRID_GAP_Y;
  }

  const width = columns * NODE_WIDTH + Math.max(0, columns - 1) * GRID_GAP_X;
  const height = Math.max(...columnHeights) - GRID_GAP_Y;
  const cx = width / 2;
  const cy = Math.max(0, height) / 2;
  for (const [id, pos] of raw) {
    positions.set(id, { x: pos.x - cx, y: pos.y - cy });
  }

  return { positions, lanes: [] };
}

function placeRing(
  positions: Map<string, { x: number; y: number }>,
  nodes: GraphNode[],
  center: { x: number; y: number },
  radius: number,
  startAngle = -Math.PI / 2,
) {
  if (nodes.length === 0) return;
  if (nodes.length === 1) {
    const node = nodes[0];
    if (node) positions.set(node.id, { x: center.x + radius, y: center.y });
    return;
  }
  nodes.forEach((node, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / nodes.length;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });
}

function clusterLayout(nodes: GraphNode[], centerId: string): GraphLayout {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return { positions, lanes: [] };

  const ordered = nodes.slice().sort((a, b) => {
    const at = GRID_TYPE_ORDER.get(a.entity_type) ?? 999;
    const bt = GRID_TYPE_ORDER.get(b.entity_type) ?? 999;
    if (at !== bt) return at - bt;
    return (a.name ?? a.summary ?? a.id).localeCompare(b.name ?? b.summary ?? b.id);
  });
  const centerNode = ordered.find((node) => node.id === centerId) ?? ordered[0];
  if (!centerNode) return { positions, lanes: [] };
  positions.set(centerNode.id, { x: 0, y: 0 });

  const childNodes = ordered.filter((node) => node.id !== centerNode.id);
  const radius = Math.max(CLUSTER_CHILD_RADIUS, childNodes.length * 26);
  placeRing(positions, childNodes, { x: 0, y: 0 }, radius);

  for (const node of ordered) {
    if (!positions.has(node.id)) positions.set(node.id, { x: 0, y: 0 });
  }

  return { positions, lanes: [] };
}

function dagreLayout(nodes: GraphNode[], links: GraphLink[], centerId: string): GraphLayout {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return { positions, lanes: [] };

  const heightById = new Map<string, number>();
  for (const n of nodes) heightById.set(n.id, nodeRenderHeight(n));

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: "LR",
    nodesep: 40,
    ranksep: 80,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: heightById.get(n.id) ?? NODE_HEIGHT });
  }
  // Use a deterministic edge key (the index) so duplicate synapses between
  // the same pair don't clobber each other.
  links.forEach((l, i) => {
    const src = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
    const tgt = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
    if (!g.hasNode(src) || !g.hasNode(tgt)) return;
    g.setEdge(src, tgt, {}, `e${i}`);
  });

  dagre.layout(g);

  const laneByKey = new Map<
    string,
    { key: string; id: string | null; label: string; nodes: GraphNode[]; maxPpr: number }
  >();
  for (const node of nodes) {
    const principal = principalLaneFor(node);
    const lane = laneByKey.get(principal.key) ?? {
      key: principal.key,
      id: principal.id,
      label: principal.label,
      nodes: [],
      maxPpr: 0,
    };
    lane.nodes.push(node);
    lane.maxPpr = Math.max(lane.maxPpr, node.ppr ?? 0);
    if (principal.label !== principal.id) lane.label = principal.label;
    laneByKey.set(principal.key, lane);
  }
  const centerNode = nodes.find((n) => n.id === centerId);
  const centerLaneKey = centerNode ? principalLaneFor(centerNode).key : null;
  const lanesByPrincipal = Array.from(laneByKey.values()).sort((a, b) => {
    if (a.key === centerLaneKey) return -1;
    if (b.key === centerLaneKey) return 1;
    if (a.key === UNKNOWN_PRINCIPAL_KEY) return 1;
    if (b.key === UNKNOWN_PRINCIPAL_KEY) return -1;
    if (b.maxPpr !== a.maxPpr) return b.maxPpr - a.maxPpr;
    return a.label.localeCompare(b.label);
  });
  // Each lane's vertical extent fits the TALLEST card it contains
  // (plus header + bottom padding). Lanes stack downward by
  // accumulating those per-lane heights so a tall card in one lane
  // never overlaps a card in the lane below.
  const laneTopByKey = new Map<string, number>();
  const laneHeightByKey = new Map<string, number>();
  let accumulatedY = 0;
  for (const lane of lanesByPrincipal) {
    const maxCardHeight = lane.nodes.reduce(
      (max, n) => Math.max(max, heightById.get(n.id) ?? NODE_HEIGHT),
      NODE_HEIGHT,
    );
    const laneHeight = LANE_HEADER_HEIGHT + maxCardHeight + LANE_BOTTOM_PADDING;
    laneTopByKey.set(lane.key, accumulatedY);
    laneHeightByKey.set(lane.key, laneHeight);
    accumulatedY += laneHeight + LANE_GAP;
  }

  const raw = new Map<string, { x: number; y: number }>();
  let globalMinX = Number.POSITIVE_INFINITY;
  let globalMaxX = Number.NEGATIVE_INFINITY;

  for (const lane of lanesByPrincipal) {
    const laneNodes = lane.nodes.sort((a, b) => {
      const ax = g.node(a.id)?.x ?? 0;
      const bx = g.node(b.id)?.x ?? 0;
      if (ax !== bx) return ax - bx;
      if ((b.ppr ?? 0) !== (a.ppr ?? 0)) return (b.ppr ?? 0) - (a.ppr ?? 0);
      return a.id.localeCompare(b.id);
    });
    const laneTop = laneTopByKey.get(lane.key) ?? 0;
    let rightEdge = Number.NEGATIVE_INFINITY;

    for (const n of laneNodes) {
      const pos = g.node(n.id);
      const dagreX = pos && Number.isFinite(pos.x) ? pos.x - NODE_WIDTH / 2 : 0;
      const x = Math.max(dagreX, rightEdge + NODE_GAP_X);
      const y = laneTop + LANE_HEADER_HEIGHT;
      raw.set(n.id, { x, y });
      rightEdge = x + NODE_WIDTH;
      globalMinX = Math.min(globalMinX, x);
      globalMaxX = Math.max(globalMaxX, x + NODE_WIDTH);
    }
  }

  const focalRaw = raw.get(centerId);
  const focalHeight = heightById.get(centerId) ?? NODE_HEIGHT;
  const cx = (focalRaw?.x ?? 0) + NODE_WIDTH / 2;
  const cy = (focalRaw?.y ?? 0) + focalHeight / 2;

  for (const n of nodes) {
    const pos = raw.get(n.id);
    if (pos) {
      positions.set(n.id, { x: pos.x - cx, y: pos.y - cy });
    } else {
      positions.set(n.id, { x: 0, y: 0 });
    }
  }

  if (!Number.isFinite(globalMinX) || !Number.isFinite(globalMaxX)) {
    globalMinX = 0;
    globalMaxX = NODE_WIDTH;
  }

  const laneRawX = globalMinX - LANE_PADDING_X;
  const laneX = laneRawX - cx;
  const laneWidth = globalMaxX - globalMinX + LANE_PADDING_X * 2;
  const lanes = lanesByPrincipal.map((lane) => {
    const laneTop = laneTopByKey.get(lane.key) ?? 0;
    const laneHeight =
      laneHeightByKey.get(lane.key) ?? LANE_HEADER_HEIGHT + NODE_HEIGHT + LANE_BOTTOM_PADDING;
    return {
      id: `swim-lane:${lane.key}`,
      principalId: lane.id,
      label: lane.label,
      count: lane.nodes.length,
      x: laneX,
      y: laneTop - cy,
      width: laneWidth,
      height: laneHeight,
    };
  });

  return { positions, lanes };
}

function SwimLaneNode() {
  return (
    <div
      className="h-full w-full rounded-md border border-dashed border-border bg-background/55"
      aria-hidden="true"
      data-swim-lane-band="principal"
    />
  );
}

interface EntityNodeCardProps {
  id: string;
  href: string;
  entityType: string;
  title: string;
  summary: string;
  count?: number;
  createdAt: string | null;
  isCenter?: boolean;
  ppr: number;
  gpr: number;
  lifecycle: string;
  accentColor: string;
  background: string;
  cardHeight: number;
  showPersonalizedRank: boolean;
  referenceNumber?: number;
  isNew?: boolean;
}

function EntityNodeCard({
  id,
  href,
  entityType,
  title,
  summary,
  count,
  createdAt,
  isCenter,
  ppr,
  gpr,
  lifecycle,
  accentColor,
  background,
  cardHeight,
  showPersonalizedRank,
  referenceNumber,
  isNew,
}: EntityNodeCardProps) {
  const hasDistinctTitle = title !== summary;
  const clampStyle = {
    display: "-webkit-box",
    WebkitLineClamp: NODE_MAX_SUMMARY_LINES,
    WebkitBoxOrient: "vertical" as const,
  };

  return (
    <Link
      to={href}
      aria-label={`Open ${entityType} ${title}`}
      className={`nodrag nopan relative flex cursor-pointer flex-col gap-1 overflow-visible py-3 pl-4 pr-10 text-left text-inherit no-underline shadow-sm transition-shadow duration-150 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring${isNew ? " doco-new-node-glow" : ""}`}
      data-entity-node-card={entityType}
      data-entity-node-new={isNew ? "true" : undefined}
      data-graph-reference-number={referenceNumber ?? undefined}
      data-neuron-href={href}
      data-neuron-id={id}
      data-neuron-label={title}
      data-neuron-lifecycle={lifecycle}
      data-neuron-type={entityType}
      draggable={false}
      onClick={(event) => event.stopPropagation()}
      style={{
        width: NODE_WIDTH,
        minHeight: cardHeight,
        background,
        border: isCenter ? "2px solid var(--color-border)" : "1px solid var(--color-border)",
        borderRadius: 8,
        boxShadow: `inset -${NODE_STRIPE_WIDTH}px 0 0 ${accentColor}`,
      }}
    >
      {referenceNumber ? (
        <span
          aria-label={`Graph reference ${referenceNumber}: ${title}`}
          className="pointer-events-none absolute -left-3 -top-3 z-30 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
          title={`Graph reference ${referenceNumber}`}
        >
          {referenceNumber}
        </span>
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-0 z-20 flex flex-col items-center pt-2 text-white"
        style={{ width: NODE_STRIPE_WIDTH }}
      >
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          {lifecycleLabel(lifecycle)}
        </span>
        <span
          className="mt-3 text-[9px] font-medium tracking-wider opacity-90"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          {relativeTime(createdAt)}
        </span>
      </div>
      <div className="relative z-10 flex items-center gap-2 text-left">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-foreground">
          <NeuronTypeIcon entityType={entityType} className="!h-4 !w-4 shrink-0" />
          <span>{entityType}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {isCenter ? (
            <>
              <span className="font-medium text-foreground">in focus</span>
              <span title="Global PageRank (over the whole Doco graph)">
                GPR <span className="text-foreground">{gpr.toFixed(3)}</span>
              </span>
            </>
          ) : showPersonalizedRank ? (
            <>
              <span title="Personalized PageRank from focal neuron">
                PPR <span className="text-foreground">{ppr.toFixed(3)}</span>
              </span>
              <span title="Global PageRank (over the whole Doco graph)">
                GPR <span className="text-foreground">{gpr.toFixed(3)}</span>
              </span>
            </>
          ) : count != null ? (
            <span title="Neurons represented by this cluster">
              <span className="text-foreground">{count.toLocaleString()}</span> nodes
            </span>
          ) : (
            <span title="Global PageRank (over the whole Doco graph)">
              GPR <span className="text-foreground">{gpr.toFixed(3)}</span>
            </span>
          )}
        </span>
      </div>
      {hasDistinctTitle ? (
        <div className="relative z-10 truncate text-left font-mono text-xs font-semibold text-foreground">
          {title}
        </div>
      ) : null}
      <div
        className={[
          "relative z-10 overflow-hidden text-left",
          hasDistinctTitle
            ? "text-[11px] leading-snug text-muted-foreground"
            : "font-mono text-sm font-semibold leading-snug text-foreground",
        ].join(" ")}
        data-entity-node-summary="true"
        style={{ ...clampStyle }}
      >
        {summary}
      </div>
    </Link>
  );
}

export function EntityGraph({
  centerId,
  nodes,
  links,
  hrefFor,
  layoutMode = "swimlanes",
  showPersonalizedRank = true,
  fillHeight = false,
}: EntityGraphProps) {
  const navigate = useNavigate();
  const graphReferenceIdRef = useRef(`entity-${Math.random().toString(36).slice(2)}`);

  const allLifecycles = useMemo(() => {
    const set = new Set<string>(["active"]);
    for (const n of nodes) {
      if (n.entity_type === "principal") continue;
      set.add(nodeLifecycle(n));
    }
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
  const [visibleLifecycles, setVisibleLifecycles] = useState<Set<string>>(
    () =>
      new Set(allLifecycles.filter((lifecycle) => !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle))),
  );

  useEffect(() => {
    setVisibleLifecycles((prev) => {
      const next = new Set<string>();
      for (const lifecycle of allLifecycles) {
        if (prev.has(lifecycle) || !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle)) {
          next.add(lifecycle);
        }
      }
      return next;
    });
  }, [allLifecycles]);

  const visible = useMemo(() => {
    const v = nodes.filter((n) => {
      if (n.entity_type === "principal") return false;
      if (!visibleLifecycles.has(nodeLifecycle(n))) return false;
      if (showPersonalizedRank && n.id === centerId) return true;
      return true;
    });
    const ids = new Set(v.map((n) => n.id));
    const vl = links.filter((l) => {
      // Drop administrative synapses that clutter the render and carry no
      // process / reasoning value (decision_01KRRJTW39THBW0C943G0GTH0M).
      if (ALWAYS_HIDDEN_EDGE_TYPES.has(l.synapse_type)) return false;
      const src = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
      const tgt = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
      return ids.has(src) && ids.has(tgt);
    });
    return { nodes: v, links: vl };
  }, [nodes, links, visibleLifecycles, centerId, showPersonalizedRank]);

  // Track which nodes arrived via a live refresh (vs. were present on
  // first mount). Diffed against the full incoming `nodes` set, not
  // `visible.nodes`, so toggling a lifecycle filter back on doesn't
  // glow nodes that have been around the whole time.
  const allNodeIds = useMemo(() => nodes.map((n) => n.id), [nodes]);
  const newNodeIds = useNewNodeIds(allNodeIds);

  const layout = useMemo(() => {
    if (layoutMode === "cluster") return clusterLayout(visible.nodes, centerId);
    if (layoutMode === "grid") return rankedGridLayout(visible.nodes);
    return dagreLayout(visible.nodes, visible.links, centerId);
  }, [visible.nodes, visible.links, centerId, layoutMode]);
  const positions = layout.positions;
  const visibleNodeById = useMemo(() => {
    const byId = new Map<string, GraphNode>();
    for (const node of visible.nodes) byId.set(node.id, node);
    return byId;
  }, [visible.nodes]);
  const nodeTypes = useMemo(() => ({ swimLane: SwimLaneNode }), []);

  // Dynamic import — react-flow uses window/document.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape hatch
  const [Flow, setFlow] = useState<any>(null);
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const [graphSize, setGraphSize] = useState<GraphSize>({ width: 1, height: 1 });
  const updateViewport = (next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  };
  useEffect(() => {
    let canceled = false;
    import("@xyflow/react").then((mod) => {
      if (!canceled) setFlow(() => mod);
    });
    return () => {
      canceled = true;
    };
  }, []);

  // Round the viewport-window corners inside the MiniMap. React Flow
  // renders the mask as an SVG <path> with two subpaths — an outer rect
  // covering the panel bounds, and the inner viewport rect cut out via
  // `fill-rule: evenodd`. The inner subpath uses sharp `h`/`v` commands
  // (square corners), which read as a square window inside an otherwise-
  // rounded panel. Patch `d` to substitute arc commands so the viewport
  // matches the panel radius. `d` is recomputed on every pan/zoom, so a
  // MutationObserver keeps the rounding applied.
  const graphRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const update = () =>
      setGraphSize({
        width: Math.max(1, el.clientWidth),
        height: Math.max(1, el.clientHeight),
      });
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!Flow) return;
    let canceled = false;
    let lastAppliedD = "";

    const roundInner = (path: SVGPathElement) => {
      if (canceled) return;
      const d = path.getAttribute("d") ?? "";
      if (d === lastAppliedD) return;
      // Second `M` starts the inner viewport subpath.
      const innerIdx = d.indexOf("M", 1);
      if (innerIdx < 0) return;
      const inner = d.slice(innerIdx);
      // Parse `M x,y h w v h h -w z` — the rectangular viewport.
      const m = inner.match(/^M([-\d.]+),([-\d.]+)h([-\d.]+)v([-\d.]+)h/);
      if (!m) return;
      const x = Number.parseFloat(m[1]);
      const y = Number.parseFloat(m[2]);
      const w = Number.parseFloat(m[3]);
      const h = Number.parseFloat(m[4]);
      if (!Number.isFinite(x + y + w + h) || w < 12 || h < 12) return;
      const r = Math.min(6, w / 4, h / 4);
      const r2 = r * 2;
      const rounded =
        `M${x + r},${y}` +
        `h${w - r2}a${r},${r} 0 0 1 ${r},${r}` +
        `v${h - r2}a${r},${r} 0 0 1 ${-r},${r}` +
        `h${-(w - r2)}a${r},${r} 0 0 1 ${-r},${-r}` +
        `v${-(h - r2)}a${r},${r} 0 0 1 ${r},${-r}z`;
      const newD = d.slice(0, innerIdx) + rounded;
      if (newD === d) return;
      lastAppliedD = newD;
      path.setAttribute("d", newD);
    };

    let obs: MutationObserver | null = null;
    const attach = () => {
      if (canceled || !graphRef.current) return;
      const path = graphRef.current.querySelector<SVGPathElement>(".react-flow__minimap-mask");
      if (!path) {
        requestAnimationFrame(attach);
        return;
      }
      roundInner(path);
      obs = new MutationObserver(() => roundInner(path));
      obs.observe(path, { attributes: true, attributeFilter: ["d"] });
    };
    attach();
    return () => {
      canceled = true;
      obs?.disconnect();
    };
  }, [Flow]);

  const graphReferences = useMemo<GraphReferenceItem[]>(() => {
    if (viewport.zoom < GRAPH_REFERENCE_ZOOM) return [];
    return visible.nodes
      .flatMap((node) => {
        const position = positions.get(node.id);
        if (!position) return [];
        const cardHeight = nodeRenderHeight(node);
        if (!isNodeVisibleInViewport(position, viewport, graphSize, cardHeight)) return [];
        const href =
          node.href ??
          (hrefFor ? hrefFor(node.id, node.entity_type) : `/${node.entity_type}/${node.id}`);
        return [
          {
            node,
            position: screenPosition(position, viewport),
            href,
          },
        ];
      })
      .sort((a, b) => {
        const rowDiff = a.position.y - b.position.y;
        if (Math.abs(rowDiff) > NODE_HEIGHT * viewport.zoom) return rowDiff;
        const colDiff = a.position.x - b.position.x;
        if (colDiff !== 0) return colDiff;
        return a.node.id.localeCompare(b.node.id);
      })
      .slice(0, MAX_GRAPH_REFERENCES)
      .map((entry, index) => ({
        number: index + 1,
        id: entry.node.id,
        entity_type: entry.node.entity_type,
        label: entry.node.name ?? entry.node.summary ?? entry.node.id,
        lifecycle: entry.node.lifecycle ?? "active",
        href: entry.href,
      }));
  }, [visible.nodes, positions, viewport, graphSize, hrefFor]);

  const referenceNumberByNodeId = useMemo(
    () => new Map(graphReferences.map((reference) => [reference.id, reference.number])),
    [graphReferences],
  );

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    publishGraphReferences(graphId, "entity", graphReferences);
  }, [graphReferences]);

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    return () => clearGraphReferences(graphId);
  }, []);

  const flowNodes = useMemo(() => {
    const laneNodes = layout.lanes.map((lane) => ({
      id: lane.id,
      type: "swimLane",
      position: { x: lane.x, y: lane.y },
      data: {},
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      zIndex: 0,
      style: {
        width: lane.width,
        height: lane.height,
        padding: 0,
        border: "none",
        background: "transparent",
        pointerEvents: "none" as const,
      },
    }));

    const entityNodes = visible.nodes.map((n) => {
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      const lifecycle = nodeLifecycle(n);
      const accentColor = lifecycleColor(lifecycle);
      const bg = n.is_center
        ? "color-mix(in oklch, var(--color-accent) 30%, white)"
        : "rgb(255,255,255)";
      const title = n.name ?? n.summary;
      const cardHeight = nodeRenderHeight(n);
      // Make the card itself a real link. React Flow's node-level click
      // remains as a fallback, but the anchor gives expected browser affordances.
      const href = n.href ?? (hrefFor ? hrefFor(n.id, n.entity_type) : `/${n.entity_type}/${n.id}`);
      return {
        id: n.id,
        position: pos,
        // `initialWidth`/`initialHeight` (not `width`/`height`) so the
        // MiniMap has valid dimensions on first render — ResizeObserver
        // still refines them once the DOM measures. With `width`/`height`,
        // height stayed `undefined` until measurement and the MiniMap's
        // `getInternalNodesBounds` collapsed to 0-height, leaving the
        // mini-map blank.
        initialWidth: NODE_WIDTH,
        initialHeight: cardHeight,
        data: {
          label: (
            <EntityNodeCard
              id={n.id}
              href={href}
              entityType={n.entity_type}
              title={title}
              summary={n.summary}
              count={n.count}
              createdAt={n.lifecycle_since ?? n.created_at}
              isCenter={n.is_center}
              ppr={n.ppr}
              gpr={n.gpr}
              lifecycle={lifecycle}
              cardHeight={cardHeight}
              accentColor={accentColor}
              background={bg}
              showPersonalizedRank={showPersonalizedRank}
              referenceNumber={referenceNumberByNodeId.get(n.id)}
              isNew={newNodeIds.has(n.id)}
            />
          ),
        },
        zIndex: 2,
        style: {
          background: "transparent",
          border: "none",
          padding: 0,
          width: NODE_WIDTH,
          overflow: "visible",
        },
        sourcePosition: "right" as const,
        targetPosition: "left" as const,
      };
    });

    return [...laneNodes, ...entityNodes];
  }, [
    visible.nodes,
    layout.lanes,
    positions,
    hrefFor,
    showPersonalizedRank,
    referenceNumberByNodeId,
    newNodeIds,
  ]);

  const laneLabelRails = useMemo(() => {
    const height = graphSize.height || 480;
    return layout.lanes.map((lane) => {
      const laneTop = lane.y * viewport.zoom + viewport.y;
      const laneBottom = (lane.y + lane.height) * viewport.zoom + viewport.y;
      if (laneBottom <= 0 || laneTop >= height) return null;

      const visibleTop = Math.max(0, laneTop);
      const visibleBottom = Math.min(height, laneBottom);
      const railHeight = Math.min(height, Math.max(44, visibleBottom - visibleTop));
      const top = Math.min(Math.max(0, visibleTop), Math.max(0, height - railHeight));

      return (
        <div
          key={lane.id}
          className="absolute left-0 flex w-8 items-center justify-center border-r border-border bg-background/90 shadow-sm"
          style={{ top, height: railHeight }}
          data-swim-lane-label={lane.id}
          title={`${lane.label} (${lane.count})`}
        >
          <span
            className="block max-h-full overflow-hidden whitespace-nowrap px-1 text-[10px] font-semibold uppercase text-muted-foreground"
            style={{
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              textOverflow: "ellipsis",
            }}
          >
            {lane.label}
          </span>
        </div>
      );
    });
  }, [layout.lanes, viewport, graphSize.height]);

  const flowEdges = useMemo(
    () =>
      visible.links.map((l, i) => {
        const src = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
        const tgt = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
        return {
          id: `${src}-${tgt}-${l.synapse_type}-${i}`,
          source: src,
          target: tgt,
          label: l.synapse_type,
          labelStyle: {
            fontSize: 9,
            fill: "#737373",
            pointerEvents: "none" as const,
          },
          labelBgPadding: [2, 4] as [number, number],
          labelBgBorderRadius: 4,
          labelBgStyle: { fill: "#f5f5f5", fillOpacity: 0.9, pointerEvents: "none" as const },
          // Edges are visual only — never the click target. Removing the
          // invisible hit zone and label pointer-events lets the pan handler
          // receive drag-mousedowns that happen to start on an edge line or
          // its label, so the cursor has the whole canvas to grab.
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          style: { stroke: "rgba(115, 115, 115, 0.5)", pointerEvents: "none" as const },
        };
      }),
    [visible.links],
  );

  const MiniMapNode = useMemo(
    () =>
      function DocoMiniMapNode({
        id,
        x,
        y,
        width,
        height,
        style,
        selected,
        className,
        color,
        strokeColor,
        borderRadius = 5,
        shapeRendering,
      }: MiniMapNodeProps) {
        const graphNode = visibleNodeById.get(id);
        if (!graphNode) return null;
        const fill =
          color ??
          (typeof style?.background === "string" ? style.background : undefined) ??
          (typeof style?.backgroundColor === "string" ? style.backgroundColor : undefined) ??
          "rgb(255,255,255)";
        const stripeColor = lifecycleColor(graphNode?.lifecycle);
        const radius = Math.min(borderRadius, width / 4, height / 4);
        const stripeWidth = Math.min(34, Math.max(18, width * 0.16));
        const stripeRight = x + stripeWidth;
        const bottom = y + height;
        const stripeRadius = Math.min(radius, stripeWidth, height / 2);
        const stripePath = [
          `M${x + stripeRadius},${y}`,
          `L${stripeRight},${y}`,
          `L${stripeRight},${bottom}`,
          `L${x + stripeRadius},${bottom}`,
          `Q${x},${bottom} ${x},${bottom - stripeRadius}`,
          `L${x},${y + stripeRadius}`,
          `Q${x},${y} ${x + stripeRadius},${y}`,
          "Z",
        ].join(" ");
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
              style={{
                fill,
                stroke: strokeColor ?? "var(--color-border)",
                strokeWidth: graphNode?.is_center ? 2 : 1,
                vectorEffect: "non-scaling-stroke",
              }}
            />
            <path d={stripePath} style={{ fill: stripeColor }} />
          </g>
        );
      },
    [visibleNodeById],
  );

  return (
    <div className={fillHeight ? "flex h-full min-h-0 flex-col gap-2" : "flex flex-col gap-2"}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Life cycle:</span>
          {allLifecycles.map((lifecycle) => {
            const checked = visibleLifecycles.has(lifecycle);
            const color = lifecycleColor(lifecycle);
            const label = lifecycleLabel(lifecycle);
            return (
              <label
                key={lifecycle}
                className="inline-flex cursor-pointer select-none items-center gap-1"
                title={label}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setVisibleLifecycles((prev) => {
                      const next = new Set(prev);
                      if (checked) next.delete(lifecycle);
                      else next.add(lifecycle);
                      return next;
                    });
                  }}
                  className="h-3 w-3"
                  style={{ accentColor: color }}
                />
                <span className="capitalize" style={{ color }}>
                  {label}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div
        ref={graphRef}
        className={
          fillHeight
            ? "relative min-h-0 w-full flex-1 overflow-hidden rounded-md border border-border bg-input"
            : "relative h-[65vh] min-h-[480px] w-full overflow-hidden rounded-md border border-border bg-input"
        }
      >
        {visible.nodes.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center text-center text-sm font-medium text-muted-foreground">
            So empty
          </div>
        ) : Flow ? (
          <>
            <Flow.ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              fitView
              fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
              minZoom={GRAPH_MIN_ZOOM}
              onInit={(instance: { getViewport?: () => FlowViewport }) => {
                const next = instance.getViewport?.();
                if (next) updateViewport(next);
              }}
              onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
              onNodeClick={(_e: unknown, n: { id: string }) => {
                const node = visible.nodes.find((x) => x.id === n.id);
                if (!node) return;
                // hrefFor is always provided by callers in production; the fallback exists
                // only for ad-hoc tests/storybook. Use the short form (no `/e/`).
                const href =
                  node.href ??
                  (hrefFor
                    ? hrefFor(node.id, node.entity_type)
                    : `/${node.entity_type}/${node.id}`);
                navigate(href);
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Flow.Background gap={20} size={1} />
              <Flow.Controls
                position="top-right"
                showInteractive={false}
                fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
              />
              <Flow.MiniMap
                nodeComponent={MiniMapNode}
                pannable
                zoomable
                maskColor="rgba(0, 0, 0, 0.35)"
                style={{
                  width: 120,
                  height: 90,
                  border: "1px solid var(--color-border)",
                  // Match the parent graph container's `rounded-md` so the
                  // MiniMap nests cleanly inside Doco's component radii.
                  borderRadius: "var(--radius)",
                  // The inner SVG mask path is a rectangle — without
                  // clipping, the dark mask-fill corners poke past the
                  // rounded panel border. `overflow: hidden` clips the SVG
                  // to the rounded panel shape.
                  overflow: "hidden",
                }}
              />
            </Flow.ReactFlow>
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 overflow-hidden">
              {laneLabelRails}
            </div>
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Loading graph…
          </div>
        )}
      </div>
    </div>
  );
}
