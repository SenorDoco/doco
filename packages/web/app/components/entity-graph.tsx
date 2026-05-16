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
import { nodeTypeColor } from "~/lib/node-colors";
import "@xyflow/react/dist/style.css";

/**
 * Administrative edge types that carry no reading value in the rendered
 * graph and clutter every neighborhood. Filtered out at render time
 * (decision_01KRRJTW39THBW0C943G0GTH0M). The underlying edges remain in
 * the index — this is a visualization-only filter.
 *
 * Note: `created_by` / `updated_by` used to be filtered here. They're now
 * skipped at index time (see SKIP_FIELDS in packages/index/src/edges.ts),
 * so the runtime filter is just for legacy edges still sitting in the DB
 * from before the change.
 */
const HIDDEN_EDGE_TYPES: ReadonlySet<string> = new Set(["in_scope_of", "created_by", "updated_by"]);

export interface GraphNode {
  id: string;
  node_type: string;
  summary: string;
  /** Scopes carry their `name` here; other entity types leave it null. */
  name: string | null;
  /** Principal who owns this node's lane, usually the creator/actor. */
  principal_id?: string | null;
  principal_label?: string | null;
  created_at: string | null;
  /** Personalized PageRank from the focal node (1.0 = focal node itself). */
  ppr: number;
  /** Global PageRank — uniform-restart PR over the whole Doco graph. */
  gpr: number;
  is_center?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
  edge_type: string;
  /**
   * Where the edge came from. Explicit edges render solid; doco-auto
   * edges render dashed + lighter so the viewer can see which links the
   * LLM proposed vs. which the source declared. Per the
   * `llm-auto-edge-detection-on-capture` ADR.
   */
  attribution?: "explicit" | "doco-auto";
}

interface EntityGraphProps {
  centerId: string;
  nodes: GraphNode[];
  links: GraphLink[];
  hrefFor?: (id: string, nodeType: string) => string;
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

const TYPE_PLURAL_LABEL: Record<string, string> = {
  doco: "docos",
  principal: "principals",
  organization: "organizations",
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "references",
  scope: "scopes",
};

function typePluralLabel(type: string): string {
  return TYPE_PLURAL_LABEL[type] ?? `${type}s`;
}

const UNKNOWN_PRINCIPAL_KEY = "__unknown_principal__";
const UNKNOWN_PRINCIPAL_LABEL = "Unknown principal";

function principalLaneFor(node: GraphNode): { key: string; id: string | null; label: string } {
  if (node.node_type === "principal") {
    return {
      key: node.id,
      id: node.id,
      label: node.name ?? node.summary ?? node.id,
    };
  }

  if (node.principal_id) {
    return {
      key: node.principal_id,
      id: node.principal_id,
      label: node.principal_label ?? node.principal_id,
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
 * Edges that don't carry process / reasoning value (`in_scope_of`,
 * `created_by`, `updated_by`) are filtered upstream so they don't
 * influence the layout.
 *
 * Returns positions keyed by node id, with the focal node centered at
 * (0, 0) so the existing `fitView` viewport math keeps working. Falls
 * back to the focal node only when Dagre cannot place a node (extreme
 * edge case — disconnected isolates).
 */
const NODE_WIDTH = 240;
const NODE_HEIGHT = 100;
const NODE_GAP_X = 56;
const LANE_HEIGHT = 148;
const LANE_GAP = 24;
const LANE_HEADER_HEIGHT = 36;
const LANE_PADDING_X = 16;
function dagreLayout(nodes: GraphNode[], links: GraphLink[], centerId: string): GraphLayout {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return { positions, lanes: [] };

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
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  // Use a deterministic edge key (the index) so duplicate edges between
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
  const laneTopByKey = new Map<string, number>();
  lanesByPrincipal.forEach((lane, i) => {
    laneTopByKey.set(lane.key, i * (LANE_HEIGHT + LANE_GAP));
  });

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
  const cx = (focalRaw?.x ?? 0) + NODE_WIDTH / 2;
  const cy = (focalRaw?.y ?? 0) + NODE_HEIGHT / 2;

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
    return {
      id: `swim-lane:${lane.key}`,
      principalId: lane.id,
      label: lane.label,
      count: lane.nodes.length,
      x: laneX,
      y: laneTop - cy,
      width: laneWidth,
      height: LANE_HEIGHT,
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

export function EntityGraph({ centerId, nodes, links, hrefFor }: EntityGraphProps) {
  const navigate = useNavigate();

  // Scope nodes are never shown as neighbors — they're a categorical
  // membership signal, not part of the focal node's reasoning chain. The
  // focal node itself stays visible even when it's a scope (otherwise the
  // graph on a scope-detail page would be empty).
  const allTypes = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) {
      if (n.node_type === "scope") continue;
      set.add(n.node_type);
    }
    return Array.from(set).sort();
  }, [nodes]);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const v = nodes.filter((n) => {
      if (n.id === centerId) return true;
      if (n.node_type === "scope") return false;
      return !hiddenTypes.has(n.node_type);
    });
    const ids = new Set(v.map((n) => n.id));
    const vl = links.filter((l) => {
      // Drop administrative edges that clutter the render and carry no
      // process / reasoning value (decision_01KRRJTW39THBW0C943G0GTH0M).
      if (HIDDEN_EDGE_TYPES.has(l.edge_type)) return false;
      const src = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
      const tgt = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
      return ids.has(src) && ids.has(tgt);
    });
    return { nodes: v, links: vl };
  }, [nodes, links, hiddenTypes, centerId]);

  const layout = useMemo(
    () => dagreLayout(visible.nodes, visible.links, centerId),
    [visible.nodes, visible.links, centerId],
  );
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
  const [graphHeight, setGraphHeight] = useState(0);
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
    const update = () => setGraphHeight(el.clientHeight);
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

  // Card background fades white → neutral-300 as PPR drops. Range is taken
  // across non-focal nodes so the focal AND the highest-PPR neighbor both
  // land at white; weaker neighbors recede toward gray.
  const pprBounds = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const n of visible.nodes) {
      if (n.is_center) continue;
      if (n.ppr < min) min = n.ppr;
      if (n.ppr > max) max = n.ppr;
    }
    return { min, max };
  }, [visible.nodes]);

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
      const color = nodeTypeColor(n.node_type);
      const pprRange = pprBounds.max - pprBounds.min;
      let bg = "rgb(255,255,255)";
      if (n.is_center) {
        bg = "color-mix(in oklch, var(--color-accent) 30%, white)";
      } else if (pprRange > 0) {
        const t = (n.ppr - pprBounds.min) / pprRange;
        const v = Math.round(212 + 43 * t);
        bg = `rgb(${v},${v},${v})`;
      }
      const title = n.name ?? (n.summary.length > 40 ? `${n.summary.slice(0, 40)}…` : n.summary);
      // Subtitle only adds value when the title is a distinct handle (name).
      // For nameless nodes the title already IS the summary — showing it
      // twice (or as a prefix of itself) is noise.
      const subtitle = n.name
        ? n.summary.length > 80
          ? `${n.summary.slice(0, 80)}…`
          : n.summary
        : null;
      const NODE_W = 240;
      // Make the card itself a real link. React Flow's node-level click
      // remains as a fallback, but the anchor gives expected browser affordances.
      const href = hrefFor ? hrefFor(n.id, n.node_type) : `/${n.node_type}/${n.id}`;
      return {
        id: n.id,
        position: pos,
        // `initialWidth`/`initialHeight` (not `width`/`height`) so the
        // MiniMap has valid dimensions on first render — ResizeObserver
        // still refines them once the DOM measures. With `width`/`height`,
        // height stayed `undefined` until measurement and the MiniMap's
        // `getInternalNodesBounds` collapsed to 0-height, leaving the
        // mini-map blank.
        initialWidth: NODE_W,
        initialHeight: subtitle ? 100 : 78,
        data: {
          label: (
            <Link
              to={href}
              aria-label={`Open ${n.node_type} ${title}`}
              className="nodrag nopan flex cursor-pointer flex-col gap-0.5 overflow-hidden px-3 py-2 text-inherit no-underline"
              draggable={false}
              onClick={(event) => event.stopPropagation()}
              style={{ width: NODE_W }}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider" style={{ color }}>
                  {n.node_type}
                </span>
              </div>
              <div className="truncate font-mono text-xs font-semibold text-foreground">
                {title}
              </div>
              {subtitle ? (
                <div
                  className="overflow-hidden text-[10px] leading-tight text-muted-foreground"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical" as const,
                  }}
                >
                  {subtitle}
                </div>
              ) : null}
              <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
                <span className="truncate">{relativeTime(n.created_at)}</span>
                {n.is_center ? (
                  <span className="flex shrink-0 items-center gap-2 font-mono">
                    <span className="font-medium text-foreground">Node in focus</span>
                    <span title="Global PageRank (over the whole Doco graph)">
                      GPR <span className="text-foreground">{n.gpr.toFixed(3)}</span>
                    </span>
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-2 font-mono">
                    <span title="Personalized PageRank from focal node">
                      PPR <span className="text-foreground">{n.ppr.toFixed(3)}</span>
                    </span>
                    <span title="Global PageRank (over the whole Doco graph)">
                      GPR <span className="text-foreground">{n.gpr.toFixed(3)}</span>
                    </span>
                  </span>
                )}
              </div>
            </Link>
          ),
        },
        zIndex: 2,
        style: {
          background: bg,
          // Borders stay gray for every node — the type is signalled by
          // the colored stripe drawn inside the left edge of the card
          // (boxShadow inset). Focal keeps a 2px gray border for weight.
          border: n.is_center ? "2px solid var(--color-border)" : "1px solid var(--color-border)",
          borderRadius: 8,
          padding: 0,
          width: NODE_W,
          overflow: "hidden",
          boxShadow: `inset 4px 0 0 ${color}`,
        },
        sourcePosition: "right" as const,
        targetPosition: "left" as const,
      };
    });

    return [...laneNodes, ...entityNodes];
  }, [visible.nodes, layout.lanes, positions, pprBounds, hrefFor]);

  const laneLabelRails = useMemo(() => {
    const height = graphHeight || 480;
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
  }, [layout.lanes, viewport, graphHeight]);

  const flowEdges = useMemo(
    () =>
      visible.links.map((l, i) => {
        const src = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
        const tgt = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
        const isAuto = l.attribution === "doco-auto";
        return {
          id: `${src}-${tgt}-${l.edge_type}-${i}`,
          source: src,
          target: tgt,
          label: isAuto ? `${l.edge_type} (auto)` : l.edge_type,
          labelStyle: {
            fontSize: 9,
            fill: isAuto ? "#a3a3a3" : "#737373",
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
          // Auto-detected edges render dashed + lighter so the eye can tell
          // them apart from explicit (person/agent-authored) ones.
          style: isAuto
            ? {
                stroke: "rgba(112, 122, 35, 0.25)",
                strokeDasharray: "4 4",
                pointerEvents: "none" as const,
              }
            : { stroke: "rgba(112, 122, 35, 0.5)", pointerEvents: "none" as const },
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
        const stripeColor = nodeTypeColor(graphNode?.node_type ?? "");
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="text-muted-foreground">Show:</span>
        {allTypes.map((t) => {
          const v = !hiddenTypes.has(t);
          const color = nodeTypeColor(t);
          const label = typePluralLabel(t);
          return (
            <label
              key={t}
              className="inline-flex cursor-pointer select-none items-center gap-1"
              title={label}
            >
              <input
                type="checkbox"
                checked={v}
                onChange={() => {
                  setHiddenTypes((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(t);
                    else next.delete(t);
                    return next;
                  });
                }}
                className="h-3 w-3"
                style={{ accentColor: color }}
              />
              <span style={{ color }}>{label}</span>
            </label>
          );
        })}
      </div>

      <div
        ref={graphRef}
        className="relative h-[65vh] min-h-[480px] w-full overflow-hidden rounded-md border border-border bg-input"
      >
        {Flow ? (
          <>
            <Flow.ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              fitView
              fitViewOptions={{ padding: 0.05, maxZoom: 1.6 }}
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
                const href = hrefFor
                  ? hrefFor(node.id, node.node_type)
                  : `/${node.node_type}/${node.id}`;
                navigate(href);
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Flow.Background gap={20} size={1} />
              <Flow.Controls position="top-right" showInteractive={false} />
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
