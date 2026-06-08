// BPMN perspective — swim lanes, BPMN-inspired shapes, lifecycle
// coloring. Owned by torrenegra per the seeded perspectives row.
//
// Layout strategy:
//   • One horizontal lane per principal (plus process bands).
//   • Lanes are React Flow parent nodes; nodes set parentId to nest
//     visually inside their lane.
//   • Within each lane, nodes are placed in a topological sweep over
//     explicit `flows_to` edges. Stored source -> target direction
//     is rendered directly; association edges do not become arrows.
//   • Lifecycle color renders as the shape's stroke; the type icon
//     identifies the node type at a glance.
//
// Shape rendering uses custom React Flow node types — one component
// per shape (circle, diamond, rectangle, document, rounded). Handles
// sit on left/right edges so edges connect cleanly regardless of
// lane vertical offset.

import { Handle, MarkerType, Position, type Edge as ReactFlowEdge, useStore } from "@xyflow/react";
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { FadingPlaceholderEdge } from "~/components/fading-placeholder-edge";
import { isEdgeLifecycleVisible } from "~/components/lifecycle-filter";
import {
  LifecycleBadge,
  NodeBadgeRow,
  ReferenceNumberBadge,
  TypeBadge,
  badgeStyle,
} from "~/components/node-badges";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { StandardControls } from "~/components/perspective-canvas-overlays";
import { StableLabeledBezierEdge, clickableEdgeClassName } from "~/components/stable-labeled-edge";
import {
  computeDepthFromCenter,
  focalEdgeWidth,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import { type LifecycleCounts, lifecycleColor, textOnLifecycle } from "~/lib/node-colors";
import { perspectiveCountLabel, visibleLifecycleTotal } from "~/lib/perspective-count";
import { usePublishedReferences } from "~/lib/perspective-references";
import {
  type ParentProcess,
  computeExternalNeighbours,
  computeParentProcesses,
} from "~/lib/process-boundary";
import { processEdgeLabelData } from "~/lib/process-edge-label-style";
import { topEntryPointId } from "~/lib/process-entry-points";
import {
  processExpansionFitNodeId,
  processFocusFlowNodeId,
  processPoolFitNodeIds,
} from "~/lib/process-focus-fit";
import { packProcessLaneColumns } from "~/lib/process-lane-packing";
import { type LaneRowNode, computeLaneRowCenters } from "~/lib/process-lane-rows";
import { processSimplifiedAtZoom } from "~/lib/process-lod";
import type {
  ProcessLane,
  ProcessNode,
  ProcessPool,
  ProcessShape,
} from "~/lib/process-perspective.server";
import { processReferences } from "~/lib/process-references";
import { computeForwardSequenceDepths } from "~/lib/process-sequence-depth";
import { indexById, reuseStableNodes } from "~/lib/process-stable-nodes";
import { subprocessPoolId } from "~/lib/process-subprocess";
import {
  ReferenceNumberStoreContext,
  createReferenceNumberStore,
  useReferenceNumber,
} from "~/lib/reference-number-store";
import "@xyflow/react/dist/style.css";

// MUST stay in sync with the matching exports in
// `~/lib/process-perspective.server`. Can't import the values here —
// `.server.ts` modules are stripped from the client bundle, so
// value-imports from them fail the build.
const MILESTONE_LANE_ID = "__milestones__";
const ARTIFACTS_LANE_ID = "__artifacts__";
// The synthetic overview pool — mirrors POOL_TOP_LEVEL_ID in
// `~/lib/process-perspective.server` (a `.server` value can't be imported into
// the client bundle). The overview (home) state frames this one pool, which
// holds every top-level process as a task node in its principal's lane.
export const TOP_LEVEL_POOL_ID = "pool:top-level";

interface ProcessPerspectiveProps {
  docoHandle?: string | null;
  /**
   * One pool per process — an Action with `has_parent` children (plus an
   * "Unassigned" pool for flow nodes with no parent process). Pools are
   * rendered in the order given — the server emits them oldest-process
   * first, with the Unassigned pool pinned to the bottom.
   */
  pools: ProcessPool[];
  /**
   * Flat list of lanes across all pools; each lane carries its
   * `pool_id` so the renderer can group them. Lane ids are composite
   * (`<pool_id>::<base>`) so the same Principal in two pools is two
   * distinct lanes.
   */
  lanes: ProcessLane[];
  nodes: ProcessNode[];
  /** TRUE per-lifecycle totals of BPMN flow nodes (steps) before the server cap.
   *  The overlay sums the stages the lifecycle filter shows, so the count tracks
   *  the canvas. Defaults to the loaded slice when absent (fixtures/mocks). */
  totalByLifecycle?: LifecycleCounts;
  links: OverviewGraphLink[];
  onNodeClick?: (node: ProcessNode) => void;
  onPoolClick?: (pool: ProcessPool) => void;
  onLaneClick?: (lane: ProcessLane) => void;
  /**
   * Lift focal-node state to the parent. Clicking a node on the
   * canvas should re-center the graph on it so depth-based opacity
   * recomputes from the new focal node; the parent owns the centerId
   * state and this callback is how the canvas asks it to update.
   * Same contract as OverviewGraph.onCenterChange.
   */
  onCenterChange?: (id: string | null) => void;
  onPaneClick?: () => void;
  /**
   * Picking a process from the home list focuses that process Action. The
   * host uses this to reflect the focus in the URL (a focus-only
   * `/action/<id>` link), so the view is shareable and the Back button works.
   */
  onProcessOpen?: (processId: string) => void;
  /**
   * The Home button reset to the default (process-list) view. The host
   * uses this to clear the focused-node URL back to the bare perspective.
   */
  onHomeReset?: () => void;
  /**
   * Page-level lifecycle filter set. Nodes whose lifecycle isn't in
   * this set are excluded; lanes that end up empty after filtering
   * are dropped from the lane list. When omitted, every node is
   * shown.
   */
  visibleLifecycles?: Set<string>;
  /**
   * When set, the BPMN canvas fades non-neighbours of this node
   * based on BFS depth (focused 100%, 1st-degree 75%, 2nd 50%, 3rd+ 25%).
   * Edges fade with their deepest endpoint. When null/undefined,
   * every node and edge renders at full opacity.
   */
  centerId?: string | null;
  /**
   * One-shot viewport instruction for direct node URLs. Centers the
   * matching BPMN node, pool header, or actor lane at 100% zoom.
   */
  initialFocusId?: string | null;
  focusedEdgeId?: string | null;
  focusedNodeIds?: Iterable<string> | null;
  onEdgeClick?: (edge: OverviewGraphLink) => void;
}

const LANE_HEIGHT = 140;
// Small inset on every lane so the dashed swimlane separator doesn't
// touch the canvas's absolute left edge. Reads as a margin between
// the page chrome and the BPMN visualization. Lanes start at canvas
// x=LANE_LEFT_INSET; children sit relative to their parent so they
// shift right with it.
const LANE_LEFT_INSET = 16;
// The milestone band runs perpendicular to the lanes in BPMN, so it
// reads as a phase ribbon rather than a swim lane. Keep it compact so
// it doesn't compete visually with the actor lanes below.
const MILESTONE_BAND_HEIGHT = 90;
const MILESTONE_NODE_HEIGHT = 44;
const MILESTONE_NODE_WIDTH = 120;
// The artifacts band sits below the actor lanes and holds Evals, Ideas,
// and Rules — the BPMN data objects / annotations / business-rule tasks
// that sit *alongside* the flow rather than in a swim lane. Slightly
// taller than the milestone band so the documents inside don't crowd,
// but still shorter than an actor lane.
const ARTIFACTS_BAND_HEIGHT = 120;
const LANE_LABEL_WIDTH = 140;
// Keep the first node visually separated from the swim-lane label
// divider. Without this, column-zero nodes can sit flush against the
// label boundary when they are the widest shape in the graph.
const LANE_CONTENT_LEFT_GUTTER = 32;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 60;
// Horizontal gap between columns. Edge tags (`flows_to`, condition labels
// like Yes/No/Recurrent) render in this band, so it's kept wide enough for
// a label to sit between two nodes without overlapping either shape.
const NODE_GAP_X = 120;
const NODE_GAP_Y = 40; // padding above/below stacked rows inside the lane
const PROCESS_RENDER_EDGE_BUDGET = 700;
const PROCESS_PLACEHOLDER_STUB_BUDGET = 120;
// Long swim-lane processes can run far wider than the viewport. ReactFlow
// clamps the reachable zoom at `minZoom`, so the floor has to sit low enough
// for `fitView` (and manual scroll/pinch) to pull the whole flow on screen.
export const PROCESS_MIN_ZOOM = 0.02;
export const PROCESS_MAX_ZOOM = 2.0;

/**
 * Per-node box sizing — the label's character count drives how big
 * the React Flow box needs to be to fit the text without truncation.
 *
 * Formula: text area ≈ N * char_w * line_h, padded by `pad`. For
 * circles we square the box so the inscribed circle stays round.
 * NODE_WIDTH x NODE_HEIGHT is the floor — short labels keep the
 * default size so existing layouts don't shift unexpectedly.
 */
function sizeForNode(node: ProcessNode): { width: number; height: number } {
  const label = node.name ?? "";
  const N = Math.max(label.length, 1);
  const CHAR_W = 5.5; // approx px per char at 10px font, leading-tight
  const LINE_H = 13;
  const PAD = 24; // total horizontal padding inside the shape
  // Vertical padding. Bigger than the horizontal pad because the #N badge (top)
  // and the type/lifecycle badge row (bottom) both straddle the node's edges:
  // the extra room keeps a long, centered label from running under either of
  // them. The label is flex-centered, so the room splits evenly top and bottom.
  const PAD_Y = 24;
  // Target a roughly square text block so wrapping looks balanced.
  const sqrtPx = Math.sqrt(N * CHAR_W * LINE_H);
  const w = Math.max(NODE_WIDTH, Math.ceil(sqrtPx) + PAD);
  const h = Math.max(NODE_HEIGHT, Math.ceil(sqrtPx) + PAD_Y);
  if (node.shape === "circle") {
    const dim = Math.max(w, h);
    return { width: dim, height: dim };
  }
  return { width: w, height: h };
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

interface FlowModule {
  ReactFlow: typeof import("@xyflow/react").ReactFlow;
  Background: typeof import("@xyflow/react").Background;
  Controls: typeof import("@xyflow/react").Controls;
  ControlButton: typeof import("@xyflow/react").ControlButton;
}

/** The side effects opening a node from the BPMN canvas commands. Injected so
 *  the open rule is pure and unit-testable, free of React state. */
export interface CanvasOpenHandlers {
  setHomeMode: (value: boolean) => void;
  setExpandedProcessId: (id: string | null) => void;
  onCenterChange?: (id: string | null) => void;
  onNodeClick?: (node: ProcessNode) => void;
  navigate: (href: string) => void;
}

/**
 * Open a node from the BPMN canvas. A plain click (`expandSubprocess: false`)
 * focuses the node but keeps any sub-process collapsed inside its parent's
 * pool, so the parent pool frames — IDENTICAL to opening any other node. The
 * "View subprocess" affordance (`expandSubprocess: true`) is the ONLY thing
 * that opens a sub-process's OWN pool, and only for an Action that is actually
 * a sub-process. Either way the node dialog opens, exactly as a normal click
 * does.
 */
export function openCanvasNode(
  node: ProcessNode,
  options: { expandSubprocess: boolean },
  handlers: CanvasOpenHandlers,
): void {
  handlers.setHomeMode(false);
  handlers.setExpandedProcessId(
    options.expandSubprocess && subprocessPoolId(node) ? node.id : null,
  );
  handlers.onCenterChange?.(node.id);
  if (handlers.onNodeClick) handlers.onNodeClick(node);
  else if (node.href) handlers.navigate(node.href);
}

/**
 * A box drawn OUTSIDE the focal pool stands in for a cross-pool sequence-flow
 * neighbour — a node in another process that flows into or out of this one. Its
 * React Flow id is `external:…` and its `data.node` is the real node in the
 * other pool. Clicking it focuses that node (which renders its OWN pool).
 * Returns that node, or null for any other flow node.
 */
export function clickedExternalNeighbour(flowNode: {
  id: string;
  data?: unknown;
}): ProcessNode | null {
  if (!flowNode.id.startsWith("external:")) return null;
  const node = (flowNode.data as { node?: ProcessNode } | undefined)?.node;
  return node ?? null;
}

/** What clicking a flow node on the BPMN canvas should do. */
export type CanvasNodeClick =
  | { kind: "pool"; pool: ProcessPool }
  | { kind: "parentProcess"; processId: string }
  | { kind: "node"; node: ProcessNode };

/**
 * Route a BPMN canvas click by what was hit. The canvas draws a few synthetic
 * boxes alongside the real flow nodes, so a click means different things:
 *
 *   • a pool header → focus that whole pool;
 *   • a `parent:` box (a process THIS pool hangs under) → drill UP into it;
 *   • an `external:` box (a node in another pool) → open that real node;
 *   • any real node — INCLUDING the synthetic overview pool's directory entries
 *     — → open it through the shared node-open, which alone decides whether to
 *     drill into a pool: only a sub-process Action does (`subprocessPoolId`),
 *     and only via that one path. So a default-view entry renders and behaves
 *     identically to a node anywhere else — a non-process Action never opens a
 *     pool view just because it sits in the overview.
 *
 * Routing is pure so the "overview entries are just nodes" rule is unit-tested,
 * not duplicated inside a JSX handler.
 */
export function resolveCanvasNodeClick(
  flowNode: { id: string; data?: unknown },
  ctx: {
    poolByHeaderId: Map<string, ProcessPool>;
    nodeById: Map<string, ProcessNode>;
  },
): CanvasNodeClick | null {
  const pool = ctx.poolByHeaderId.get(flowNode.id);
  if (pool) return { kind: "pool", pool };
  if (flowNode.id.startsWith("parent:")) {
    const processId = flowNode.id.slice("parent:".length).split("::")[0];
    return { kind: "parentProcess", processId };
  }
  const external = clickedExternalNeighbour(flowNode);
  if (external) return { kind: "node", node: external };
  const target = ctx.nodeById.get(flowNode.id);
  if (!target) return null;
  return { kind: "node", node: target };
}

export function ProcessPerspective({
  docoHandle,
  pools,
  lanes: lanesRaw,
  nodes: nodesRaw,
  totalByLifecycle,
  links: linksRaw,
  onNodeClick,
  onPoolClick,
  onLaneClick,
  onCenterChange,
  onPaneClick,
  onProcessOpen,
  onHomeReset,
  visibleLifecycles,
  centerId,
  initialFocusId,
  focusedEdgeId,
  focusedNodeIds,
  onEdgeClick,
}: ProcessPerspectiveProps) {
  const lanes = lanesRaw;
  const nodes = nodesRaw;
  const navigate = useNavigate();
  const graphRef = useRef<HTMLDivElement>(null);
  const [Flow, setFlow] = useState<FlowModule | null>(null);
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const [graphSize, setGraphSize] = useState<GraphSize>({ width: 1, height: 1 });
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
  const flowInstanceRef = useRef<FlowInstance | null>(null);
  const initialFocusAppliedRef = useRef<string | null>(null);
  // The default (no-URL-focus) auto-fit on the highest-PageRank node is a
  // one-time mount affordance — `defaultFocusAppliedRef` flips true after
  // it fires so subsequent clicks (which reshuffle `selectionCenterId`)
  // don't yank the canvas around.
  const defaultFocusAppliedRef = useRef(false);
  // The expanded process whose pool the camera has already framed. A drill-in
  // (overview pick / "View subprocess") must re-center on the pool it opens
  // even after the one-time default fit is spent; this tracks the last
  // expansion framed so the re-fit fires once per distinct drill-in.
  const framedExpansionRef = useRef<string | null>(null);
  // The BPMN perspective opens on the synthetic top-level pool (the "home"
  // overview) — every top-level process drawn as a task node in its principal's
  // lane — rather than drilling straight into one process. An explicit camera
  // focus (a node URL, an agent auto-focus, a panel open) skips the overview
  // and drills in. Clicking a process in the overview, or arriving via such a
  // focus, switches to that process's swim-lane pool; the Home button returns
  // to the overview.
  const [homeMode, setHomeMode] = useState<boolean>(() => !initialFocusId);
  useEffect(() => {
    if (initialFocusId) setHomeMode(false);
  }, [initialFocusId]);
  // A subprocess renders collapsed (a task with a "View subprocess"
  // affordance) inside its parent's pool by default; it expands into its OWN
  // pool only when the viewer cold-opens on it or clicks "View subprocess".
  // `expandedProcessId` is the process Action id currently expanded — a plain
  // node click (or a Señor Doco auto-focus) clears it, keeping the subprocess
  // collapsed in its parent.
  const [expandedProcessId, setExpandedProcessId] = useState<string | null>(null);
  // Cold-open expansion: a direct URL focus on a process Action (a top-level
  // process header or a subprocess member) renders that process as its OWN
  // pool. Applied once per distinct `initialFocusId` so a later data refetch
  // can't re-expand a process the viewer has since collapsed by clicking.
  const coldOpenExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialFocusId || coldOpenExpandedRef.current === initialFocusId) return;
    coldOpenExpandedRef.current = initialFocusId;
    const isProcess =
      pools.some((pool) => pool.process_id === initialFocusId) ||
      nodesRaw.some((node) => node.id === initialFocusId && node.is_process);
    if (isProcess) setExpandedProcessId(initialFocusId);
  }, [initialFocusId, pools, nodesRaw]);
  // Reset the one-shot camera-fit machinery so returning to the overview (and
  // the next drill-in out of it) frames the synthetic pool / next process
  // afresh.
  const goHome = useCallback(() => {
    hasFitRef.current = false;
    flowInstanceRef.current = null;
    defaultFocusAppliedRef.current = false;
    initialFocusAppliedRef.current = null;
    setExpandedProcessId(null);
    setHomeMode(true);
    onHomeReset?.();
  }, [onHomeReset]);
  // Drill from the overview into a process's own swim-lane pool: leave home,
  // expand and center that process, and sync the URL (a focus-only action link).
  const openProcess = useCallback(
    (processId: string) => {
      setHomeMode(false);
      setExpandedProcessId(processId);
      onCenterChange?.(processId);
      onProcessOpen?.(processId);
    },
    [onCenterChange, onProcessOpen],
  );
  // The shared canvas node-open: focus the node, open its dialog as usual, and
  // frame its parent pool — a plain click keeps any sub-process collapsed where
  // it sits. Clicking the node body or an external-neighbour box routes through
  // here; the "View subprocess" affordance routes through `viewSubprocess`.
  const openNode = useCallback(
    (node: ProcessNode) =>
      openCanvasNode(
        node,
        { expandSubprocess: false },
        { setHomeMode, setExpandedProcessId, onCenterChange, onNodeClick, navigate },
      ),
    [onCenterChange, onNodeClick, navigate],
  );
  // The "View subprocess" affordance on a collapsed sub-process Action: this is
  // the ONLY click that opens the sub-process into its own pool — AND opens its
  // dialog, like any other node click.
  const viewSubprocess = useCallback(
    (node: ProcessNode) =>
      openCanvasNode(
        node,
        { expandSubprocess: true },
        { setHomeMode, setExpandedProcessId, onCenterChange, onNodeClick, navigate },
      ),
    [onCenterChange, onNodeClick, navigate],
  );
  // Pan/zoom fires `onMove` many times per frame. The React Flow canvas
  // transforms itself internally; our `viewport` mirror only feeds the
  // sticky rails and the reference-number store, so coalescing it to one
  // update per animation frame keeps those overlays in sync without
  // re-running their work on every intermediate event.
  const pendingViewportRef = useRef<FlowViewport | null>(null);
  const viewportRafRef = useRef<number | null>(null);
  const commitViewport = useCallback((next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  }, []);
  const updateViewport = useCallback(
    (next: FlowViewport) => {
      pendingViewportRef.current = next;
      if (typeof window === "undefined" || !window.requestAnimationFrame) {
        commitViewport(next);
        return;
      }
      if (viewportRafRef.current != null) return;
      viewportRafRef.current = window.requestAnimationFrame(() => {
        viewportRafRef.current = null;
        const latest = pendingViewportRef.current;
        if (latest) commitViewport(latest);
      });
    },
    [commitViewport],
  );
  useEffect(
    () => () => {
      if (viewportRafRef.current != null && typeof window !== "undefined") {
        window.cancelAnimationFrame(viewportRafRef.current);
      }
    },
    [],
  );

  // Drop nodes whose lifecycle is filtered out. The lane list itself isn't
  // lifecycle-filtered here — a lane carries no lifecycle of its own to test
  // against — but a lane left with no visible nodes is dropped downstream by
  // layOutProcess, so an emptied swim lane (a retired principal once "Retired"
  // is hidden) disappears instead of rendering as a blank band. Links are
  // still filtered by the existing nodeSet check inside layOutProcess.
  const { filteredNodes, filteredLanes } = useMemo(() => {
    if (!visibleLifecycles) return { filteredNodes: nodes, filteredLanes: lanes };
    const fn = nodes.filter((n) => visibleLifecycles.has(n.lifecycle ?? "active"));
    return { filteredNodes: fn, filteredLanes: lanes };
  }, [nodes, lanes, visibleLifecycles]);

  // The lifecycle filter applies to edges too: a retired `flows_to`
  // sequence edge hides by default (retired is off out of the box) and
  // reappears only when "Retired" is toggled on. Filtering here — before
  // every downstream consumer (neighbour expansion, layout, edge stubs) —
  // means a hidden-lifecycle edge never draws and never pulls a neighbour
  // into the rendered set. Endpoint-visibility is still enforced
  // separately by the `renderedNodeIds` checks downstream.
  const links = useMemo(() => {
    if (!visibleLifecycles) return linksRaw;
    return linksRaw.filter((link) => isEdgeLifecycleVisible(link, visibleLifecycles));
  }, [linksRaw, visibleLifecycles]);

  useEffect(() => {
    let alive = true;
    import("@xyflow/react").then((mod) => {
      if (!alive) return;
      setFlow({
        ReactFlow: mod.ReactFlow,
        Background: mod.Background,
        Controls: mod.Controls,
        ControlButton: mod.ControlButton,
      });
    });
    return () => {
      alive = false;
    };
  }, []);

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

  const nodeByFullId = useMemo(
    () => new Map(filteredNodes.map((node) => [node.id, node])),
    [filteredNodes],
  );
  const filteredNodeIds = useMemo(
    () => new Set(filteredNodes.map((node) => node.id)),
    [filteredNodes],
  );
  const focusCenterId = useMemo(() => {
    if (
      centerId &&
      (nodeByFullId.has(centerId) || pools.some((pool) => pool.process_id === centerId))
    ) {
      return centerId;
    }
    return null;
  }, [centerId, nodeByFullId, pools]);
  // Cold-open default (no node in the URL): the first pool's entry point.
  // Pools arrive oldest-first from the server, so this lands on the start
  // of the oldest process — deterministic, no PageRank.
  const defaultCenterId = useMemo(
    () => pools.find((pool) => pool.process_id)?.process_id ?? filteredNodes[0]?.id ?? null,
    [pools, filteredNodes],
  );
  const selectionCenterId = useMemo(
    () => focusCenterId ?? defaultCenterId ?? centerId ?? null,
    [focusCenterId, defaultCenterId, centerId],
  );
  // The overview (home) state frames the synthetic top-level pool — the one
  // pool that is not an Action, holding every top-level process as a task node
  // in its principal's lane. It exists only when the loader emitted it (the
  // Doco has at least one top-level process); absent that, home falls back to
  // framing the first process pool so the canvas is never blank.
  const homePoolId = useMemo(
    () => pools.find((pool) => pool.id === TOP_LEVEL_POOL_ID)?.id ?? null,
    [pools],
  );
  useEffect(() => {
    if (!centerId || focusCenterId || !selectionCenterId || selectionCenterId === centerId) return;
    onCenterChange?.(selectionCenterId);
  }, [centerId, focusCenterId, selectionCenterId, onCenterChange]);
  const focusedNodeIdSet = useMemo(() => new Set(focusedNodeIds ?? []), [focusedNodeIds]);

  const resolveProcessToEntry = useCallback(
    (id: string | null | undefined): string | null =>
      resolveProcessCenter(id, { expandedProcessId, pools, nodes: filteredNodes, links }),
    [pools, filteredNodes, links, expandedProcessId],
  );
  // The single node the view is focused on. Always defined (falls back to
  // the first pool's entry point), because the BPMN perspective always
  // frames one focal node and the one swim lane that owns it.
  // In the overview (home) state the synthetic top-level pool frames the whole
  // directory — it owns no single node, so there's no focal node to resolve and
  // the depth-fade/highlight stay off. (With no top-level pool to show, home
  // falls through to framing the first process pool.)
  const effectiveCenterId = useMemo(
    () => (homeMode && homePoolId ? null : resolveProcessToEntry(selectionCenterId)),
    [homeMode, homePoolId, resolveProcessToEntry, selectionCenterId],
  );
  // The pool(s) drawn as swim lanes, and the exact set of nodes rendered —
  // no budget, no PageRank windowing, no buffering. A node focus (or an
  // edge within one intent) frames one pool: the focal node's whole intent
  // plus its first-degree sequence-flow neighbours in *other* intents,
  // which lay out above/below the lane (see layOutProcess). A focused edge
  // whose endpoints span two intents frames BOTH pools in full. Clicking a
  // node makes it the focal node and the whole set recomputes from scratch.
  const { focalPoolIds, renderedNodeIds } = useMemo(
    () =>
      computeProcessRenderedSet({
        nodes: filteredNodes,
        pools,
        links,
        centerId: effectiveCenterId,
        expandedProcessId,
        focusedEdgeId: focusedEdgeId ?? null,
        focusedNodeIds: focusedNodeIdSet,
        defaultPoolId: homeMode ? homePoolId : null,
      }),
    [
      filteredNodes,
      pools,
      links,
      effectiveCenterId,
      expandedProcessId,
      focusedEdgeId,
      focusedNodeIdSet,
      homeMode,
      homePoolId,
    ],
  );
  const renderedNodes = useMemo(
    () => filteredNodes.filter((node) => renderedNodeIds.has(node.id)),
    [filteredNodes, renderedNodeIds],
  );
  // Only the focal pool(s) are drawn as swim lanes, so only their rendered
  // nodes contribute swim-lane chrome (rails, reference numbering). Adjacent
  // cross-intent nodes render above/below the lane and belong to none.
  const renderedLaneIds = useMemo(
    () =>
      new Set(
        renderedNodes.filter((node) => focalPoolIds.has(node.pool_id)).map((node) => node.laneId),
      ),
    [renderedNodes, focalPoolIds],
  );
  const renderedPoolIds = focalPoolIds;
  const renderedLanes = useMemo(
    () => filteredLanes.filter((lane) => renderedLaneIds.has(lane.id)),
    [filteredLanes, renderedLaneIds],
  );
  const renderedPools = useMemo(
    () => pools.filter((pool) => renderedPoolIds.has(pool.id)),
    [pools, renderedPoolIds],
  );
  // The focal pool(s) laid out as swim lanes — one for a node/single-intent
  // focus, two for a cross-intent edge. Their lanes anchor the in-lane
  // nodes; any adjacent cross-intent neighbours are placed above/below.
  const layoutPools = useMemo(
    () => pools.filter((pool) => focalPoolIds.has(pool.id)),
    [pools, focalPoolIds],
  );
  const layoutLanes = useMemo(
    () => filteredLanes.filter((lane) => focalPoolIds.has(lane.pool_id)),
    [filteredLanes, focalPoolIds],
  );
  // Geometry is solved from exactly the rendered set — the layout is
  // recomputed in full on every focus change, nothing is pinned.
  const layoutLinks = useMemo(
    () =>
      links.filter((link) => renderedNodeIds.has(link.source) && renderedNodeIds.has(link.target)),
    [links, renderedNodeIds],
  );
  // Focusing a whole Intent (the home-list pick, a pool-header click, or an
  // process URL) frames the entire pool without singling out any node — so the
  // depth-fade + focal highlight are suppressed. Focusing a specific node
  // (clicking a shape) still highlights it. `selectionCenterId` is the process
  // Action id in the former case and a node id in the latter.
  const isProcessFocus = useMemo(
    () => pools.some((pool) => pool.process_id === selectionCenterId),
    [pools, selectionCenterId],
  );
  // A cross-process edge frames two whole processes; singling out one focal
  // node with a depth-fade would wash the *other* process out, so suppress
  // it. The two edge endpoints are still highlighted via `focusedNodeIds`.
  const highlightFocal = !isProcessFocus && focalPoolIds.size <= 1;
  const layout = useMemo(
    () =>
      layOutProcess(
        layoutPools,
        layoutLanes,
        renderedNodes,
        layoutLinks,
        effectiveCenterId,
        focusedNodeIdSet,
        focusedEdgeId ?? null,
        highlightFocal,
      ),
    [
      layoutPools,
      layoutLanes,
      renderedNodes,
      layoutLinks,
      effectiveCenterId,
      focusedNodeIdSet,
      focusedEdgeId,
      highlightFocal,
    ],
  );
  // memo() so a node/edge component only re-renders when its own props
  // change. Paired with the stable `flowNodes` identity above, this keeps
  // pan/zoom and focus shifts from re-rendering all 65+ shapes at once.
  // The maps are built once (empty deps), so the memo wrappers are stable.
  const nodeTypes = useMemo(
    () => ({
      processLane: memo(ProcessLaneNode),
      processPoolHeader: memo(ProcessPoolHeaderNode),
      processCircle: memo(ProcessCircleNode),
      processDiamond: memo(ProcessDiamondNode),
      processRectangle: memo(ProcessRectangleNode),
      processDocument: memo(ProcessDocumentNode),
      processRounded: memo(ProcessRoundedNode),
      processTask: memo(ProcessTaskNode),
      processMilestone: memo(ProcessMilestoneNode),
      processEdgeStub: memo(ProcessEdgeStubNode),
    }),
    [],
  );
  const edgeTypes = useMemo(
    () => ({
      fadingPlaceholder: memo(FadingPlaceholderEdge),
      stableLabeledBezier: memo(StableLabeledBezierEdge),
    }),
    [],
  );
  const nodeById = useMemo(() => new Map(renderedNodes.map((n) => [n.id, n])), [renderedNodes]);
  const laneById = useMemo(
    () => new Map(renderedLanes.map((lane) => [lane.id, lane])),
    [renderedLanes],
  );
  const poolById = useMemo(
    () => new Map(renderedPools.map((pool) => [pool.id, pool])),
    [renderedPools],
  );
  const poolByHeaderId = useMemo(
    () => new Map(renderedPools.map((pool) => [`pool-header:${pool.id}`, pool])),
    [renderedPools],
  );
  const openPoolNode = useCallback(
    (pool: ProcessPool) => {
      if (!pool.process_id) return;
      setExpandedProcessId(pool.process_id);
      if (onCenterChange) onCenterChange(pool.process_id);
      onPoolClick?.(pool);
    },
    [onCenterChange, onPoolClick],
  );
  const openLaneNode = useCallback(
    (lane: ProcessLane) => {
      if (!isActorLane(lane) || !lane.base_id.startsWith("principal_")) return;
      if (onCenterChange) onCenterChange(lane.base_id);
      onLaneClick?.(lane);
    },
    [onCenterChange, onLaneClick],
  );

  // The BPMN #N numbering belongs to the focal *Intent*, not to whatever is
  // currently on screen. `processReferences` numbers the focal Intent's full
  // membership — every pool node of every lifecycle, in creation order — so
  // the numbers are invariant under retire, hide, lifecycle-filter, pan, and
  // zoom (none of which change the membership). They shift only when a
  // different Intent comes into focus (`focalPoolIds` changes), or extend by
  // one when a node is genuinely added (it sorts last → the next free number).
  const references = useMemo(
    () => processReferences(pools, lanes, nodes, linksRaw, focalPoolIds, docoHandle),
    [pools, lanes, nodes, linksRaw, focalPoolIds, docoHandle],
  );
  const { numberById: referenceNumberByEntityId } = usePublishedReferences("process", references);
  // Publish the numbering into an external store so each #N badge can
  // subscribe to its own number. Keeping the number out of node `data`
  // is what lets `flowNodes` stay referentially stable across pans — and
  // because the numbering itself no longer depends on the viewport, a pan
  // leaves the store untouched and not even the badges re-render.
  const referenceNumberStore = useRef(createReferenceNumberStore()).current;
  useEffect(() => {
    referenceNumberStore.setNumbers(referenceNumberByEntityId);
  }, [referenceNumberByEntityId, referenceNumberStore]);

  // Cross-pool sequence-flow neighbours. A process pool renders not only its own
  // members but also the nodes in OTHER pools that connect to it through
  // `flows_to` — drawn as NORMAL boxes OUTSIDE this pool: to the LEFT when they
  // flow INTO the pool (entry), to the RIGHT when the pool flows OUT to them
  // (exit). An arrow that touches the pool's own process Action attaches to the
  // title band (the header's left/right handle); one that touches an inner
  // member draws node-to-node. Same-side neighbours stack down from the pool top
  // so they never overlap. Clicking a box focuses that node, rendering its own
  // (different) pool.
  const externalNeighbours = useMemo(() => {
    const neighbours = computeExternalNeighbours(focalPoolIds, filteredNodes, links);
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const poolById = new Map(layout.poolGeometry.map((p) => [p.id, p]));
    const stackOffset = new Map<string, number>(); // `${poolId}:${direction}` → next y
    let count = 0;

    for (const n of neighbours) {
      if (count >= PROCESS_PLACEHOLDER_STUB_BUDGET) break;
      const external = nodeByFullId.get(n.id);
      if (!external) continue;
      const poolId =
        n.attach.kind === "title" ? n.attach.poolId : nodeById.get(n.attach.nodeId)?.pool_id;
      if (!poolId) continue;
      const pool = poolById.get(poolId);
      if (!pool) continue;
      const size = sizeForNode(external);
      const key = `${poolId}:${n.direction}`;
      const offset = stackOffset.get(key) ?? 0;
      stackOffset.set(key, offset + size.height + NODE_GAP_Y);
      const x =
        n.direction === "entry"
          ? LANE_LEFT_INSET - BOUNDARY_CIRCLE_GAP - size.width
          : LANE_LEFT_INSET + layout.laneWidth + BOUNDARY_CIRCLE_GAP;
      const y = pool.y + offset;
      const attachKey = n.attach.kind === "title" ? n.attach.poolId : n.attach.nodeId;
      const id = `external:${n.direction}:${n.id}:${attachKey}`;
      const stroke = lifecycleColor(external.lifecycle);

      nodes.push({
        id,
        type: nodeTypeForShape(external.shape),
        position: { x, y },
        // The box stands in for a node in another pool; its `external:` id is
        // what routes the click to focus that node (clickedExternalNeighbour).
        data: { node: external },
        draggable: false,
        selectable: false,
        connectable: false,
        initialWidth: size.width,
        initialHeight: size.height,
        style: { width: size.width, height: size.height, zIndex: 1 },
      });

      // The in-pool end of the arrow: the title band (process Action) via a named
      // header handle, or an inner member node-to-node (default handles).
      const poolEndId =
        n.attach.kind === "title" ? `pool-header:${n.attach.poolId}` : n.attach.nodeId;
      const headerHandle =
        n.attach.kind === "title"
          ? n.direction === "entry"
            ? "pool-left"
            : "pool-right"
          : undefined;
      edges.push({
        id: `external-edge:${id}`,
        source: n.direction === "entry" ? id : poolEndId,
        target: n.direction === "entry" ? poolEndId : id,
        ...(headerHandle
          ? n.direction === "entry"
            ? { targetHandle: headerHandle }
            : { sourceHandle: headerHandle }
          : {}),
        type: "stableLabeledBezier",
        data: processEdgeLabelData(n.label, n.edgeType, stroke, 1),
        selectable: false,
        focusable: false,
        interactionWidth: 0,
        style: { stroke, strokeWidth: 1.75 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
      });
      count++;
    }

    return { nodes, edges };
  }, [
    focalPoolIds,
    filteredNodes,
    links,
    layout.poolGeometry,
    layout.laneWidth,
    nodeById,
    nodeByFullId,
  ]);

  // Parent processes — the process(es) this pool's Action hangs under
  // (`has_parent`). Each renders as a task box ON TOP of the focal pool,
  // left-aligned in a row (one beside the next), tied to the pool by a dashed
  // arrow that leaves the parent box's bottom and lands on the pool title,
  // inset from its left. An Action can belong to multiple processes, so EVERY
  // parent is drawn. Clicking a box drills into that parent's own pool.
  const parentProcesses = useMemo(() => {
    const parents = computeParentProcesses(focalPoolIds, links);
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const poolGeometryById = new Map(layout.poolGeometry.map((p) => [p.id, p]));
    const poolByPoolId = new Map(pools.map((p) => [p.id, p]));
    const byPool = new Map<string, ParentProcess[]>();
    for (const parent of parents) {
      const list = byPool.get(parent.poolId);
      if (list) list.push(parent);
      else byPool.set(parent.poolId, [parent]);
    }

    for (const [poolId, group] of byPool) {
      const geometry = poolGeometryById.get(poolId);
      if (!geometry) continue;
      // Left-aligned row: the first box starts at the pool's left edge and each
      // further parent sits beside the previous one.
      let x = LANE_LEFT_INSET;
      for (const parent of group) {
        // A parent must itself head a pool for us to label its box; that pool
        // carries the parent Action's prose and lifecycle.
        const parentPool = poolByPoolId.get(`pool:${parent.id}`);
        if (!parentPool) continue;
        const node: ProcessNode = {
          id: parent.id,
          entity_type: "action",
          name: parentPool.label,
          lifecycle: parentPool.lifecycle,
          created_at: null,
          href: docoHandle ? `/${docoHandle}/action/${parent.id}` : null,
          shape: "task",
          laneId: "",
          pool_id: parentPool.id,
          is_process: true,
        };
        const size = sizeForNode(node);
        const position = { x, y: geometry.y - PARENT_PROCESS_GAP - size.height };
        x += size.width + NODE_GAP_X;
        const id = `parent:${parent.id}::${poolId}`;
        const stroke = lifecycleColor(node.lifecycle);
        nodes.push({
          id,
          type: nodeTypeForShape(node.shape),
          position,
          // `isParentProcess` routes the click to drill UP into the parent's pool.
          data: { node, isParentProcess: true },
          draggable: false,
          selectable: false,
          connectable: false,
          initialWidth: size.width,
          initialHeight: size.height,
          style: { width: size.width, height: size.height, zIndex: 1 },
        });

        // A dashed arrow leaving the parent box's bottom and landing on the
        // pool title (inset from its left, not centered): the parent sits over
        // the pool it parents. has_parent is containment, never conditional, so
        // it carries no branch label — its tag is the edge type itself (every
        // process arrow shows a tag, per processEdgeLabelData).
        edges.push({
          id: `parent-edge:${id}`,
          source: id,
          sourceHandle: "parent-link-bottom",
          target: `pool-header:${poolId}`,
          targetHandle: "pool-top",
          type: "stableLabeledBezier",
          data: processEdgeLabelData(null, parent.edgeType, stroke, 1),
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          style: { stroke, strokeWidth: 1.75, strokeDasharray: "6 4" },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
        });
      }
    }

    return { nodes, edges };
  }, [focalPoolIds, links, layout.poolGeometry, pools, docoHandle]);

  // Cache of the previous render's flow nodes, keyed by id, so unchanged
  // nodes keep their object identity across layout re-runs (see below).
  const prevFlowNodesRef = useRef<Map<string, FlowNode>>(new Map());
  const flowNodes = useMemo<FlowNode[]>(() => {
    const windowed = layout.flowNodes.flatMap<FlowNode>((node) => {
      const laneData = (node.data as { lane?: ProcessLane; pool?: ProcessPool }).lane;
      const poolData = (node.data as { lane?: ProcessLane; pool?: ProcessPool }).pool;
      const isRendered =
        (laneData && renderedLaneIds.has(laneData.id)) ||
        (poolData && renderedPoolIds.has(poolData.id)) ||
        (!laneData && !poolData && renderedNodeIds.has(node.id));
      if (!isRendered) return [];
      // Reference numbers (#N badges) are deliberately NOT baked into node
      // `data` here. The numbering shifts on every pan frame, so injecting
      // it would force this whole array — and thus every React Flow node —
      // to rebuild constantly. Each badge instead subscribes to its own
      // number from the reference-number store (see ProcessBadgeRow /
      // ProcessLaneNode), keeping `flowNodes` independent of the viewport.
      if (laneData) {
        const data = {
          ...node.data,
          onLaneClick: isActorLane(laneData) ? openLaneNode : undefined,
        };
        return [{ ...node, data }];
      }
      // Nodes mount at the opacity the layout assigned (full opacity now —
      // there is no render-window fade). The `.doco-graph-fade` class still
      // smooths any opacity change a node component sets on its own.
      const className = node.className ? `${node.className} doco-graph-fade` : "doco-graph-fade";
      // A subprocess member carries the "View subprocess" affordance — its
      // stable handler (so node identity survives reuseStableNodes) opens the
      // subprocess into its own pool and its dialog. Only this button drills in;
      // a plain click on the Action body (openNode) keeps it collapsed.
      if ((node.data as unknown as ProcessNodeData).isSubprocess) {
        return [{ ...node, className, data: { ...node.data, onViewSubprocess: viewSubprocess } }];
      }
      return [{ ...node, className }];
    });
    // Reuse last render's object identity for any node whose render inputs
    // are unchanged, so the memo'd shape components skip work when a focus
    // shift re-runs the layout. (On pan this memo doesn't recompute at
    // all — none of its deps depend on the viewport anymore.)
    const built = [...windowed, ...externalNeighbours.nodes, ...parentProcesses.nodes];
    const stable = reuseStableNodes(built, prevFlowNodesRef.current);
    prevFlowNodesRef.current = indexById(stable);
    return stable;
  }, [
    layout.flowNodes,
    renderedLaneIds,
    renderedPoolIds,
    renderedNodeIds,
    openLaneNode,
    viewSubprocess,
    externalNeighbours.nodes,
    parentProcesses.nodes,
  ]);
  const flowEdges = useMemo<FlowEdge[]>(
    () => [
      ...layout.flowEdges
        .filter((edge) => renderedNodeIds.has(edge.source) && renderedNodeIds.has(edge.target))
        .slice(0, PROCESS_RENDER_EDGE_BUDGET)
        .map((edge) => {
          const className = edge.className
            ? `${edge.className} doco-graph-fade-edge`
            : "doco-graph-fade-edge";
          return { ...edge, className };
        }),
      ...externalNeighbours.edges,
      ...parentProcesses.edges,
    ],
    [layout.flowEdges, renderedNodeIds, externalNeighbours.edges, parentProcesses.edges],
  );
  // The flow-node ids currently on the canvas, and the map from a process
  // Action id to the pool it heads. Both feed the camera-fit machinery below
  // (initial/URL focus AND the drill-in re-fit), so they're computed once here
  // rather than rebuilt inside each consumer.
  const flowNodeIdSet = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes]);
  const poolIdByProcessId = useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of pools) {
      if (candidate.process_id) map.set(candidate.process_id, candidate.id);
    }
    return map;
  }, [pools]);
  // Initial focus: an explicit URL focus wins; otherwise fall back to the
  // selection center (highest global PageRank in the BPMN view) so opening
  // the perspective centers on the most important node, matching the
  // overview graph's behavior.
  const initialFocusFlowNodeId = useMemo(() => {
    // The overview (home) state has no focal node — let the camera fit the
    // whole synthetic pool (fitView) instead of zooming to one node.
    const rawTarget = initialFocusId ?? (homeMode && homePoolId ? null : selectionCenterId);
    if (!rawTarget) return null;
    // A *process* focus frames the WHOLE pool (its header, which the fit then
    // expands to header + lanes), not just the entry step; a *node* focus
    // frames that node.
    const direct = processFocusFlowNodeId(rawTarget, poolIdByProcessId, flowNodeIdSet);
    if (direct) return direct;
    // Degenerate fallbacks: a process whose pool header isn't rendered drops
    // to its entry point; an actor-lane target frames that lane.
    const target = resolveProcessToEntry(rawTarget);
    if (target && flowNodeIdSet.has(target)) return target;
    const lane = renderedLanes.find((candidate) => candidate.base_id === target);
    if (lane) {
      const id = laneNodeId(lane.id);
      if (flowNodeIdSet.has(id)) return id;
    }
    return null;
  }, [
    flowNodeIdSet,
    poolIdByProcessId,
    initialFocusId,
    selectionCenterId,
    resolveProcessToEntry,
    renderedLanes,
    homeMode,
    homePoolId,
  ]);

  // Apply the one-shot initial/default camera focus. A pool target fits the
  // WHOLE pool (header + its lanes) so the camera frames the entire process
  // instead of centering on the pool's full-width header band; any other
  // target zooms to that single node at 100%.
  const fitInitialFocus = useCallback(
    (instance: FlowInstance, targetId: string) => {
      const poolFit = processPoolFitNodeIds(targetId, renderedLanes, laneNodeId, flowNodeIdSet);
      instance.fitView?.(
        poolFit && poolFit.length > 0
          ? { nodes: poolFit.map((id) => ({ id })), padding: 0.15, maxZoom: 1, duration: 0 }
          : { nodes: [{ id: targetId }], padding: 0, minZoom: 1, maxZoom: 1, duration: 0 },
      );
      const current = instance.getViewport?.();
      if (current) updateViewport(current);
    },
    [flowNodeIdSet, renderedLanes, updateViewport],
  );

  // Re-center on a freshly opened pool. Drilling into a process — picking one
  // from the overview (`openProcess`) or the "View subprocess" affordance
  // (`viewSubprocess`) expanding a subprocess into its own pool — is a
  // deliberate "frame this pool" gesture. The one-shot fit below won't do it
  // for a *second* drill-in: a plain browse has no URL focus, so that fit
  // takes the default path, which is spent after the first frame
  // (`defaultFocusAppliedRef`). So fit the expanded pool here, once per
  // distinct expansion — that's why the first drill-in centered but later ones
  // landed wherever the new layout fell. (A plain node click clears
  // `expandedProcessId`, so it never reaches here and the camera stays put.)
  useEffect(() => {
    if (!expandedProcessId) {
      framedExpansionRef.current = null;
      return;
    }
    if (framedExpansionRef.current === expandedProcessId) return;
    const headerId = processExpansionFitNodeId(
      expandedProcessId,
      initialFocusId ?? null,
      poolIdByProcessId,
      flowNodeIdSet,
    );
    if (!headerId) return;
    const instance = flowInstanceRef.current;
    if (!instance?.fitView) return;
    const frame = requestAnimationFrame(() => {
      fitInitialFocus(instance, headerId);
      framedExpansionRef.current = expandedProcessId;
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedProcessId, initialFocusId, poolIdByProcessId, flowNodeIdSet, fitInitialFocus]);

  useEffect(() => {
    if (!initialFocusFlowNodeId) return;
    const hasExplicitFocus = Boolean(initialFocusId);
    if (hasExplicitFocus) {
      if (initialFocusAppliedRef.current === initialFocusFlowNodeId) return;
    } else if (defaultFocusAppliedRef.current) {
      return;
    }
    const instance = flowInstanceRef.current;
    if (!instance?.fitView) return;
    const frame = requestAnimationFrame(() => {
      fitInitialFocus(instance, initialFocusFlowNodeId);
      if (hasExplicitFocus) initialFocusAppliedRef.current = initialFocusFlowNodeId;
      else defaultFocusAppliedRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialFocusFlowNodeId, initialFocusId, fitInitialFocus]);

  if (filteredLanes.length === 0 && pools.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-center text-sm font-medium text-muted-foreground">
        So empty
      </div>
    );
  }

  // Sticky lane label rails — overlays anchored to the left edge of the
  // canvas so the principal label + lane outline stay visible even when
  // the user pans horizontally past the lane's natural x=0 origin.
  // Mirrors the EntityGraph rail pattern (entity-graph.tsx ~1045).
  //
  // Text + reference badge sizes scale with viewport.zoom so the sticky
  // label visually matches the in-canvas ProcessLaneNode label (which lives
  // inside React Flow's zoom transform). Font family/weight/case mirror
  // the in-canvas styling so the two reads as the same label.
  //
  // Suppress the rail when the in-canvas label is clearly visible past
  // the rail's right edge — otherwise the label reads twice. The
  // in-canvas label spans canvas x=LANE_LEFT_INSET..(LANE_LEFT_INSET +
  // LANE_LABEL_WIDTH); in screen coords that's viewport.x + lo*zoom
  // through viewport.x + hi*zoom. When the right edge is past the
  // rail's right edge the user can already read the lane name.
  // Below the LOD threshold the in-canvas pool header and lanes drop their
  // labels (see ProcessPoolHeaderNode / ProcessLaneNode). The sticky rail and
  // sticky pool-header overlays exist only to keep those labels readable
  // while panning, so suppress them too — otherwise they'd reintroduce the
  // very text the canvas just hid.
  const simplified = processSimplifiedAtZoom(viewport.zoom);
  const SWIM_RAIL_WIDTH = 32;
  const RAIL_LABEL_BASE_FONT = 11;
  const RAIL_BADGE_BASE_FONT = 10;
  const inCanvasLabelRightEdge = viewport.x + (LANE_LEFT_INSET + LANE_LABEL_WIDTH) * viewport.zoom;
  const showRailLabels = !simplified && inCanvasLabelRightEdge <= SWIM_RAIL_WIDTH;
  const laneRails = showRailLabels
    ? layout.lanes.map((lane) => {
        if (!renderedLaneIds.has(lane.id)) return null;
        const laneTop = lane.y * viewport.zoom + viewport.y;
        const laneBottom = (lane.y + lane.height) * viewport.zoom + viewport.y;
        const canvasHeight = graphSize.height || 480;
        if (laneBottom <= 0 || laneTop >= canvasHeight) return null;
        const visibleTop = Math.max(0, laneTop);
        const visibleBottom = Math.min(canvasHeight, laneBottom);
        const railHeight = Math.max(44, visibleBottom - visibleTop);
        const top = Math.min(Math.max(0, visibleTop), Math.max(0, canvasHeight - railHeight));
        const isBand = lane.kind !== "actor";
        const sourceLane = laneById.get(lane.id);
        const isClickableLane = Boolean(sourceLane && isActorLane(sourceLane));
        const referenceNumber = referenceNumberByEntityId.get(lane.id);
        const labelFontPx = RAIL_LABEL_BASE_FONT * viewport.zoom;
        const badgeFontPx = RAIL_BADGE_BASE_FONT * viewport.zoom;
        const badgeBox = badgeFontPx * 2;
        return (
          <div
            key={lane.id}
            className={`absolute left-0 flex items-center justify-center border-r shadow-sm ${
              isBand ? "border-border bg-card/85" : "border-border bg-card/90"
            }`}
            style={{
              top,
              height: railHeight,
              width: SWIM_RAIL_WIDTH,
              cursor: isClickableLane ? "pointer" : undefined,
              pointerEvents: isClickableLane ? "auto" : undefined,
            }}
            data-process-lane-rail={lane.id}
            onClick={isClickableLane && sourceLane ? () => openLaneNode(sourceLane) : undefined}
            onKeyDown={
              isClickableLane && sourceLane
                ? (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openLaneNode(sourceLane);
                  }
                : undefined
            }
            role={isClickableLane ? "button" : undefined}
            tabIndex={isClickableLane ? 0 : undefined}
            title={lane.label}
          >
            {referenceNumber ? (
              <span
                aria-label={`Graph reference #${referenceNumber}: ${lane.label}`}
                className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center justify-center rounded-full bg-primary font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
                style={{
                  top: 4,
                  minWidth: badgeBox,
                  height: badgeBox,
                  padding: `0 ${Math.max(2, badgeFontPx * 0.4)}px`,
                  fontSize: badgeFontPx,
                }}
                title={`Graph reference #${referenceNumber}`}
              >
                #{referenceNumber}
              </span>
            ) : null}
            <span
              className="block max-h-full overflow-hidden whitespace-nowrap px-1 font-mono font-semibold text-foreground"
              style={{
                writingMode: "vertical-rl",
                transform: "rotate(180deg)",
                textOverflow: "ellipsis",
                fontSize: labelFontPx,
                textTransform: "none",
                letterSpacing: 0,
              }}
            >
              {lane.label}
            </span>
          </div>
        );
      })
    : null;

  // Sticky pool header band — top-edge analogue of the lane rails.
  // When a pool's in-canvas header has scrolled past the top of the
  // canvas but the pool's body is still showing, pin the header to
  // top=0 so the Intent label stays readable. Hidden once the
  // in-canvas header is visible again (no double-label).
  const POOL_RAIL_HEIGHT = Math.max(28, POOL_HEADER_HEIGHT * viewport.zoom);
  const stickyPools = layout.poolGeometry
    .map((pool) => {
      if (!renderedPoolIds.has(pool.id)) return null;
      const poolTopScreen = pool.y * viewport.zoom + viewport.y;
      const poolBottomScreen = (pool.y + pool.height) * viewport.zoom + viewport.y;
      const canvasHeight = graphSize.height || 480;
      const headerVisible = poolTopScreen >= 0;
      const poolOnScreen = poolBottomScreen > POOL_RAIL_HEIGHT && poolTopScreen < canvasHeight;
      if (headerVisible || !poolOnScreen) return null;
      return pool;
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  return (
    <div ref={graphRef} className="relative h-full w-full">
      {/* Dataset count overlay — honest about the server cap AND the lifecycle
          filter. Sums only the steps whose lifecycle the filter shows (retired
          hides by default) against the loaded slice, so the count tracks the
          canvas instead of reading "137 steps" over a near-empty board. */}
      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded bg-card/80 px-2 py-1 text-xs tabular-nums text-muted-foreground backdrop-blur-sm">
        {perspectiveCountLabel(
          {
            loaded: filteredNodes.length,
            total: totalByLifecycle
              ? visibleLifecycleTotal(totalByLifecycle, visibleLifecycles)
              : filteredNodes.length,
          },
          "step",
        )}
      </div>
      {Flow ? (
        <ReferenceNumberStoreContext.Provider value={referenceNumberStore}>
          <Flow.ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            zIndexMode="manual"
            nodesDraggable={false}
            nodesConnectable={false}
            onlyRenderVisibleElements
            minZoom={PROCESS_MIN_ZOOM}
            maxZoom={PROCESS_MAX_ZOOM}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            preventScrolling
            onInit={(instance: FlowInstance) => {
              flowInstanceRef.current = instance;
              if (!hasFitRef.current) {
                if (initialFocusFlowNodeId) {
                  fitInitialFocus(instance, initialFocusFlowNodeId);
                  if (initialFocusId) initialFocusAppliedRef.current = initialFocusFlowNodeId;
                  else defaultFocusAppliedRef.current = true;
                } else {
                  instance.fitView?.({ padding: 0.18 });
                }
                hasFitRef.current = true;
              }
              const current = instance.getViewport?.();
              if (current) updateViewport(current);
            }}
            onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
            onPaneClick={onPaneClick}
            onNodeClick={(_e: unknown, node: { id: string; data?: unknown }) => {
              // One routing rule for every canvas click (see resolveCanvasNodeClick):
              //   • pool header → focus that whole pool;
              //   • `parent:` box → drill UP into the parent process's pool;
              //   • any real node — overview directory entries included — →
              //     openNode, which alone drills into a pool, and only for a
              //     sub-process Action. A non-process Action thus focuses where
              //     it sits and opens its dialog, never a pool view.
              const click = resolveCanvasNodeClick(node, { poolByHeaderId, nodeById });
              if (!click) return;
              if (click.kind === "pool") openPoolNode(click.pool);
              else if (click.kind === "parentProcess") openProcess(click.processId);
              else openNode(click.node);
            }}
            onEdgeClick={(event: unknown, edge: ReactFlowEdge) => {
              const link = (edge.data as { graphLink?: OverviewGraphLink } | undefined)?.graphLink;
              if (!link?.id) return;
              (event as { stopPropagation?: () => void } | null)?.stopPropagation?.();
              if (onCenterChange) onCenterChange(link.source);
              if (onEdgeClick) {
                onEdgeClick(link);
                return;
              }
              if (link.href) navigate(link.href);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Flow.Background gap={24} size={1} />
            <StandardControls onHome={goHome} />
          </Flow.ReactFlow>
        </ReferenceNumberStoreContext.Provider>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
          Loading process view…
        </div>
      )}
      {Flow ? (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 overflow-hidden"
          style={{ width: SWIM_RAIL_WIDTH }}
        >
          {laneRails}
        </div>
      ) : null}
      {Flow && !simplified && stickyPools.length > 0 ? (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex flex-col">
          {stickyPools.map((pool) => {
            const isUnassigned = pool.process_id === null;
            const sourcePool = poolById.get(pool.id);
            const isClickablePool = !isUnassigned && Boolean(sourcePool?.process_id);
            // Mirror the in-canvas ProcessPoolHeaderNode look: same overlay
            // color over an opaque card so the sticky band reads as a
            // pinned copy of the natural header (not a different chrome
            // element). Font and padding scale with viewport.zoom —
            // like the swim-lane rails — so the sticky doesn't grow
            // visually huge when zoomed out.
            const overlay = isUnassigned ? "rgba(0, 0, 0, 0.05)" : "rgba(40, 70, 160, 0.08)";
            const borderColor = isUnassigned ? "var(--color-border)" : "rgba(40, 70, 160, 0.35)";
            const labelFontPx = 12 * viewport.zoom;
            const padX = 14 * viewport.zoom;
            const referenceNumber = pool.process_id
              ? referenceNumberByEntityId.get(pool.process_id)
              : undefined;
            const badgeFontPx = 10 * viewport.zoom;
            const badgeBox = badgeFontPx * 2;
            return (
              <div
                key={pool.id}
                className="flex items-center border-b shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  height: POOL_RAIL_HEIGHT,
                  backgroundColor: "var(--color-card)",
                  backgroundImage: `linear-gradient(${overlay}, ${overlay})`,
                  borderTop: `${2 * viewport.zoom}px solid ${borderColor}`,
                  borderBottomColor: borderColor,
                  padding: `0 ${padX}px`,
                  fontSize: labelFontPx,
                  fontWeight: 700,
                  letterSpacing: 0,
                  color: isUnassigned ? "var(--color-muted-foreground, #525252)" : "#1f2937",
                  cursor: isClickablePool ? "pointer" : undefined,
                  pointerEvents: isClickablePool ? "auto" : undefined,
                }}
                onClick={isClickablePool && sourcePool ? () => openPoolNode(sourcePool) : undefined}
                onKeyDown={
                  isClickablePool && sourcePool
                    ? (event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        openPoolNode(sourcePool);
                      }
                    : undefined
                }
                role={isClickablePool ? "button" : undefined}
                tabIndex={isClickablePool ? 0 : undefined}
                title={pool.label}
              >
                {referenceNumber ? (
                  <span
                    aria-label={`Graph reference #${referenceNumber}: ${pool.label}`}
                    className="flex flex-shrink-0 items-center justify-center rounded-full bg-primary font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
                    style={{
                      minWidth: badgeBox,
                      height: badgeBox,
                      marginRight: 6 * viewport.zoom,
                      padding: `0 ${Math.max(2, badgeFontPx * 0.4)}px`,
                      fontSize: badgeFontPx,
                    }}
                    title={`Graph reference #${referenceNumber}`}
                  >
                    #{referenceNumber}
                  </span>
                ) : null}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {pool.label}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {/* Lifecycle filter + Reorder-automatically + Fullscreen toggle
          all live on PerspectiveFrame at fixed positions. BPMN just
          receives `visibleLifecycles` and filters its data. */}
    </div>
  );
}

// ─── Layout ─────────────────────────────────────────────────────────

interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  draggable: boolean;
  selectable: boolean;
  connectable: boolean;
  initialWidth?: number;
  initialHeight?: number;
  parentId?: string;
  extent?: "parent";
  style?: CSSProperties;
  className?: string;
}

interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** Named handles for the sub-process drill-down links: they leave an
   *  Action's "+" marker (bottom handle id) and land on the sub-process
   *  Intent's pool header (top handle id). Sequence-flow edges leave
   *  these undefined and bind to the id-less left/right handles. */
  sourceHandle?: string;
  targetHandle?: string;
  type: string;
  zIndex?: number;
  data?: Record<string, unknown>;
  selectable: boolean;
  focusable: boolean;
  interactionWidth: number;
  style?: CSSProperties;
  className?: string;
  animated?: boolean;
  markerEnd?: { type: MarkerType; width?: number; height?: number; color?: string };
}

interface ProcessLayout {
  flowNodes: FlowNode[];
  flowEdges: FlowEdge[];
  nodePositions: Map<string, { x: number; y: number }>;
  /**
   * Per-lane geometry used to render sticky lane label rails outside
   * the React Flow canvas. Without these, the principal label (and
   * lane outline) sits at x=0 inside the canvas content and pans out
   * of view when the user scrolls right. The overlay rails anchor a
   * thin label strip to the left edge regardless of viewport pan.
   */
  lanes: Array<{
    id: string;
    pool_id: string;
    label: string;
    y: number;
    height: number;
    kind: "actor" | "milestone" | "artifacts" | "unassigned" | "unresolved";
  }>;
  /** Per-pool geometry — y, height, label — for any chrome the
   *  renderer wants to draw around pool boundaries (header band,
   *  sticky labels, focal-overlay framing, etc.). */
  poolGeometry: Array<{
    id: string;
    label: string;
    y: number;
    height: number;
    process_id: string | null;
    lifecycle: string | null;
  }>;
  /** Full pool width (all pools span the same width). External neighbour boxes
   *  sit just outside `[LANE_LEFT_INSET, LANE_LEFT_INSET + laneWidth]`. */
  laneWidth: number;
}

const POOL_HEADER_HEIGHT = 32;
const POOL_GAP = 16;

// Entry/exit boundary circle geometry. A circle stands for a node in another
// process that connects to the focal pool through sequence flow; it sits just
// outside the anchor member (left for an entry, right for an exit).
const BOUNDARY_CIRCLE_DIAMETER = 56;
const BOUNDARY_CIRCLE_GAP = 40;
// Vertical gap between a focal pool's top edge and the parent-process boxes
// drawn above it — roomy enough that the dashed parent arrows read clearly
// above the pool (twice the side spacing the boundary neighbours use).
const PARENT_PROCESS_GAP = 80;
// How far in from the pool title's left edge the parent arrows land — the
// dashed parent links attach here instead of the title's center.
const PARENT_LINK_TITLE_INSET = 200;
// Vertical room a sub-process Action reserves on EACH of its top and bottom
// edges. The bottom strip holds the "View subprocess" affordance clear of both
// the label and the type/lifecycle badge row straddling the edge; the top strip
// mirrors it so the label (the node's core) stays vertically centered rather
// than shoved up. The layout grows the box by 2× this; the node component pads
// its label area by this much top and bottom so text never enters either strip.
const SUBPROCESS_MARKER_ROOM = 38;
// Where the "View subprocess" pill sits within the bottom strip — lifted well
// off the bottom edge so it doesn't crowd the type/lifecycle badge row that
// straddles the edge below it. The strip above is sized to keep the pill (~18px
// tall) clear of the centered label even when the label fills the box.
const SUBPROCESS_BUTTON_BOTTOM = 18;

/**
 * The focal node a process *center* resolves to. Focusing a whole process —
 * a directory pick, a pool-header click, a process URL, or "View subprocess" —
 * homes in on that process's "way in" (the earliest entry point of its pool) so
 * the camera lands inside the pool. Two cases keep the center as-is instead:
 *
 *   • the process is being expanded (`id === expandedProcessId`) — its own pool
 *     already frames, so the process Action itself is the center; and
 *   • the id is a subprocess Action sitting as a STEP inside another pool — a
 *     plain click focuses it where it sits, so it must NOT drill into its own
 *     pool. Only the "View subprocess" affordance (which expands it) does that.
 *
 * A center that is already a plain node, or a process with no entry point in the
 * visible set, passes through unchanged.
 */
export function resolveProcessCenter(
  id: string | null | undefined,
  ctx: {
    expandedProcessId: string | null | undefined;
    pools: ProcessPool[];
    nodes: ProcessNode[];
    links: OverviewGraphLink[];
  },
): string | null {
  if (!id) return null;
  if (id === ctx.expandedProcessId) return id;
  const ownPool = ctx.pools.find((pool) => pool.process_id === id);
  if (!ownPool) return id;
  // A subprocess Action rendered as a step inside its parent's pool keeps its
  // focus on the step; only expansion (handled above) drills into its own pool.
  const asStep = ctx.nodes.find((node) => node.id === id);
  if (asStep && asStep.pool_id !== ownPool.id) return id;
  return topEntryPointId(ownPool.id, ctx.nodes, ctx.links) ?? id;
}

// The exact node set the BPMN perspective draws for a given focus, and the
// pool(s) those nodes belong to. The rule:
//
//   • A process expansion (`expandedProcessId`, set by a cold-open or a
//     "View subprocess" click) frames that process's own pool.
//   • Otherwise focusing a node frames that node's pool. A subprocess clicked
//     as a plain node stays collapsed inside its parent's pool.
//   • Focusing an edge whose endpoints live in *two different processes*
//     frames BOTH pools in full, so the hand-off is shown in both contexts.
//
// Nodes in other processes that connect across the boundary are NOT pulled
// into the rendered set — the renderer draws them as boxes outside the pool.
//
// Returns the focal pool ids (one for a node/process focus, two for a
// cross-process edge) and the full set of member node ids to render.
export function computeProcessRenderedSet(params: {
  nodes: ProcessNode[];
  pools: ProcessPool[];
  links: OverviewGraphLink[];
  centerId: string | null | undefined;
  expandedProcessId?: string | null;
  focusedEdgeId: string | null;
  focusedNodeIds: ReadonlySet<string>;
  /**
   * The pool to frame when nothing else is focal — the overview's synthetic
   * top-level pool. Lets the home state render that whole pool without singling
   * out a focal node. Omitted/null elsewhere, where an empty focal set renders
   * nothing.
   */
  defaultPoolId?: string | null;
}): { focalPoolIds: Set<string>; renderedNodeIds: Set<string> } {
  const {
    nodes,
    pools,
    links,
    centerId,
    expandedProcessId,
    focusedEdgeId,
    focusedNodeIds,
    defaultPoolId,
  } = params;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const poolByProcessId = new Map(
    pools.flatMap((pool) => (pool.process_id ? [[pool.process_id, pool.id] as const] : [])),
  );

  const focalPoolIds = new Set<string>();
  // An expanded process frames its OWN pool, overriding the member's parent.
  const expandedPoolId = expandedProcessId ? poolByProcessId.get(expandedProcessId) : undefined;
  if (expandedPoolId) {
    focalPoolIds.add(expandedPoolId);
  } else if (centerId) {
    // Frame the pool the center actually sits in. A subprocess Action is both a
    // member (step) of its parent's pool AND the head of its own pool; a plain
    // focus on it must frame the parent it sits in, so the member pool wins.
    // Only a process-center with no member node (a pool header focused by
    // process_id) falls back to that process's own pool — and an *expanded*
    // process is handled above, where its own pool overrides the member parent.
    const centerPoolId = nodeById.get(centerId)?.pool_id ?? poolByProcessId.get(centerId) ?? null;
    if (centerPoolId) focalPoolIds.add(centerPoolId);
  }
  // An edge focus pulls in the pools of BOTH its endpoints, so an edge that
  // spans two processes frames both of them — not just the source's.
  if (focusedEdgeId) {
    for (const id of focusedNodeIds) {
      const poolId = nodeById.get(id)?.pool_id ?? poolByProcessId.get(id);
      if (poolId) focalPoolIds.add(poolId);
    }
  }

  // Nothing else is focal (the overview/home state): frame the default pool.
  if (focalPoolIds.size === 0 && defaultPoolId) focalPoolIds.add(defaultPoolId);

  const renderedNodeIds = new Set<string>();
  if (focalPoolIds.size === 0) return { focalPoolIds, renderedNodeIds };
  for (const node of nodes) {
    if (focalPoolIds.has(node.pool_id)) renderedNodeIds.add(node.id);
  }
  return { focalPoolIds, renderedNodeIds };
}

export function layOutProcess(
  pools: ProcessPool[],
  allLanes: ProcessLane[],
  nodes: ProcessNode[],
  links: OverviewGraphLink[],
  centerId: string | null | undefined,
  focusedNodeIds: ReadonlySet<string>,
  focusedEdgeId: string | null,
  // Whether to single out the focal node — the depth-fade + `isCenter`
  // highlight. False when the focus is a whole Intent (the home-list pick or
  // a pool-header click): the entire pool reads uniformly, nothing is
  // emphasized. `centerId` is still honored for layout (it anchors the
  // adjacent cross-intent neighbours), just not for highlighting.
  highlightFocal: boolean,
): ProcessLayout {
  // A lane with no node in the rendered set reserves no space. A swim lane
  // emptied by the lifecycle filter — e.g. a retired principal in the
  // overview pool once "Retired" is hidden, or a principal whose only work is
  // hidden — is dropped entirely rather than left as a blank band. Filtering
  // here, at the single source of layout geometry, keeps pool height and lane
  // stacking honest; toggling the hidden lifecycle back on re-populates the
  // lane and it reappears.
  const laneHasNode = new Set(nodes.map((node) => node.laneId));
  const lanes = allLanes.filter((lane) => laneHasNode.has(lane.id));

  // Depth from the focal node over the whole rendered graph — drives the
  // opacity fade (positions are unaffected, so re-focusing within a pool
  // never moves a node, only re-fades it).
  const focalDepthByNode = computeDepthFromCenter(nodes, links, centerId);
  const focalActive = highlightFocal && hasFocalNode(centerId, nodes);

  // Pool geometry is solved from the pool's own nodes and internal
  // sequence flow ONLY — never from the focal node or the adjacent
  // cross-intent neighbours. That keeps every pool node anchored when the
  // focal node changes within the same intent: only the adjacent set (and
  // the opacity ramp) changes, the swim lane stays put.
  const laneIdSet = new Set(lanes.map((lane) => lane.id));
  const poolNodes = nodes.filter((node) => laneIdSet.has(node.laneId));
  const poolNodeIds = new Set(poolNodes.map((node) => node.id));
  const poolLinks = links.filter(
    (link) => poolNodeIds.has(link.source) && poolNodeIds.has(link.target),
  );

  const byLane = new Map<string, ProcessNode[]>();
  for (const lane of lanes) byLane.set(lane.id, []);
  for (const node of poolNodes) {
    const list = byLane.get(node.laneId);
    if (list) list.push(node);
  }

  // Compute one global column per node so that sequence-flow targets
  // sit to the right of their ordinary incoming source across lanes.
  // Intentional feedback loops are treated as loopbacks instead of
  // being allowed to pull earlier nodes backward.
  const depthByNode = computeForwardSequenceDepths(poolNodes, poolLinks);

  // Each node's same-lane forward (rightward) sequence predecessors drive its
  // vertical placement below: a node rides the average line of its in-lane
  // predecessors, and a column is ordered by that line so the flow doesn't
  // cross itself. A predecessor always lives in an earlier column (lower
  // depth); an edge that points the same column or left is a loopback and is
  // ignored here.
  const poolNodeById = new Map(poolNodes.map((node) => [node.id, node]));
  const forwardPredsByNode = new Map<string, string[]>();
  for (const link of poolLinks) {
    if (!SEQUENCE_FLOW_EDGES.has(link.edge_type)) continue;
    if ((depthByNode.get(link.source) ?? 0) >= (depthByNode.get(link.target) ?? 0)) continue;
    const source = poolNodeById.get(link.source);
    const target = poolNodeById.get(link.target);
    if (!source || !target || source.laneId !== target.laneId) continue;
    const preds = forwardPredsByNode.get(link.target);
    if (preds) preds.push(link.source);
    else forwardPredsByNode.set(link.target, [link.source]);
  }

  // Within each lane, sequence depth remains the x column. Nodes that
  // share a lane and a depth stack top-to-bottom instead of stealing
  // extra horizontal columns; linear sequence chains still advance
  // rightward because their depths differ.
  const { orderedByLane, columnByNode, laneColumnStacks, maxColumn } = packProcessLaneColumns(
    lanes.map((lane) => lane.id),
    poolNodes,
    depthByNode,
  );

  // Per-node sizes. Compute first so column step and lane height can
  // accommodate the widest / tallest node anywhere in the graph —
  // keeps vertical alignment of columns across lanes. Milestones use
  // their own fixed compact size and don't count toward the lane-sizing
  // max (they live in a shorter band of their own).
  // Sub-process candidacy is a stable, data-level property: an Action that is
  // itself a process (it has `has_parent` children). It drives both the
  // reserved bottom room (below) and the "View subprocess" affordance, so a
  // node's size and glyph don't flicker as the render window shifts.
  const subprocessNodes = new Set<string>();

  const sizeByNode = new Map<string, { width: number; height: number }>();
  let maxNodeWidth = NODE_WIDTH;
  let maxNodeHeight = NODE_HEIGHT;
  for (const node of nodes) {
    const size = sizeForNode(node);
    if (subprocessPoolId(node)) {
      subprocessNodes.add(node.id);
      // Grow the box by a strip on the top AND the bottom: the bottom holds the
      // "View subprocess" affordance clear of the label, and the matching top
      // strip keeps the label centered. The component pads the label by the
      // same amount on each side; stacking/lane-height math below keys off size.
      size.height += 2 * SUBPROCESS_MARKER_ROOM;
    }
    sizeByNode.set(node.id, size);
    // Only pool nodes drive the column step / lane height, so the swim
    // lane's geometry doesn't shift when a wide adjacent neighbour comes
    // or goes.
    if (poolNodeIds.has(node.id)) {
      if (size.width > maxNodeWidth) maxNodeWidth = size.width;
      if (size.height > maxNodeHeight) maxNodeHeight = size.height;
    }
  }
  const columnStep = maxNodeWidth + NODE_GAP_X;
  const baseLaneHeight = Math.max(LANE_HEIGHT, maxNodeHeight + NODE_GAP_Y * 2);
  const laneWidth =
    LANE_LABEL_WIDTH + LANE_CONTENT_LEFT_GUTTER + (maxColumn + 1) * columnStep + NODE_GAP_X;
  // Lane height still reserves room for the tallest column's full stack, so a
  // lane never clips even when alignment fans nodes out within it.
  const maxStackHeightByLane = new Map<string, number>();
  for (const [key, stack] of laneColumnStacks.entries()) {
    const stackHeight = stack.reduce((sum, node, index) => {
      const size = sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
      return sum + size.height + (index > 0 ? NODE_GAP_Y : 0);
    }, 0);
    const laneId = key.split("\u0000")[0] ?? "";
    maxStackHeightByLane.set(laneId, Math.max(maxStackHeightByLane.get(laneId) ?? 0, stackHeight));
  }
  const laneHeightById = new Map<string, number>();
  for (const lane of lanes) {
    const stackHeight = maxStackHeightByLane.get(lane.id) ?? 0;
    laneHeightById.set(
      lane.id,
      Math.max(heightForLane(lane), baseLaneHeight, stackHeight + NODE_GAP_Y * 2),
    );
  }

  const flowNodes: FlowNode[] = [];
  const laneYById = new Map<string, number>();
  const nodePositions = new Map<string, { x: number; y: number }>();
  const poolGeometry: ProcessLayout["poolGeometry"] = [];

  // Group lanes by pool so each pool can emit its header + its own
  // lanes in display order, then accumulate height.
  const lanesByPool = new Map<string, ProcessLane[]>();
  for (const pool of pools) lanesByPool.set(pool.id, []);
  for (const lane of lanes) {
    const list = lanesByPool.get(lane.pool_id);
    if (list) list.push(lane);
  }

  let cursorY = 0;
  let poolIndex = 0;
  for (const pool of pools) {
    const poolLanes = lanesByPool.get(pool.id) ?? [];
    if (poolIndex > 0) cursorY += POOL_GAP;
    poolIndex++;
    const poolStartY = cursorY;

    // Pool header band — labeled banner across the full canvas width.
    flowNodes.push({
      id: `pool-header:${pool.id}`,
      type: "processPoolHeader",
      position: { x: LANE_LEFT_INSET, y: cursorY },
      data: {
        pool,
        width: laneWidth,
        height: POOL_HEADER_HEIGHT,
        isCenter:
          (highlightFocal && pool.process_id === centerId) ||
          Boolean(pool.process_id && focusedNodeIds.has(pool.process_id)),
      },
      draggable: false,
      selectable: false,
      connectable: false,
      initialWidth: laneWidth,
      initialHeight: POOL_HEADER_HEIGHT,
      style: {
        width: laneWidth,
        height: POOL_HEADER_HEIGHT,
        zIndex: 0,
        padding: 0,
      },
    });
    cursorY += POOL_HEADER_HEIGHT;

    // Lanes inside this pool (sorted server-side by kind +
    // alphabetical label; we just iterate).
    for (const lane of poolLanes) {
      const laneHeight = laneHeightById.get(lane.id) ?? baseLaneHeight;

      laneYById.set(lane.id, cursorY);
      laneHeightById.set(lane.id, laneHeight);
      flowNodes.push({
        id: laneNodeId(lane.id),
        type: "processLane",
        position: { x: LANE_LEFT_INSET, y: cursorY },
        data: {
          lane,
          height: laneHeight,
          width: laneWidth,
          labelWidth: LANE_LABEL_WIDTH,
          isMilestoneBand: lane.kind === "milestone",
          isArtifactsBand: lane.kind === "artifacts",
          isCenter:
            isActorLane(lane) &&
            ((highlightFocal && lane.base_id === centerId) || focusedNodeIds.has(lane.base_id)),
        },
        draggable: false,
        selectable: false,
        connectable: false,
        initialWidth: laneWidth,
        initialHeight: laneHeight,
        style: { width: laneWidth, height: laneHeight, zIndex: 0, padding: 0 },
      });
      cursorY += laneHeight;
    }
    poolGeometry.push({
      id: pool.id,
      label: pool.label,
      y: poolStartY,
      height: cursorY - poolStartY,
      process_id: pool.process_id,
      lifecycle: pool.lifecycle,
    });
  }

  // Vertical center per node within its lane. A node rides the average line of
  // its in-lane predecessors (one predecessor ⇒ exactly on its line), and each
  // column is ordered by that line so the flow stays untangled; roots and
  // un-fed nodes fall back to a centered stack.
  const rowCenterByNode = new Map<string, number>();
  for (const lane of lanes) {
    const laneHeight = laneHeightById.get(lane.id) ?? baseLaneHeight;
    const rowNodes: LaneRowNode[] = (orderedByLane.get(lane.id) ?? []).map((node, order) => ({
      id: node.id,
      column: columnByNode.get(node.id) ?? 0,
      height: (sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT }).height,
      predecessors: forwardPredsByNode.get(node.id) ?? [],
      order,
    }));
    for (const [id, center] of computeLaneRowCenters(rowNodes, laneHeight, NODE_GAP_Y)) {
      rowCenterByNode.set(id, center);
    }
  }

  // Emit node nodes nested in their lane.
  for (const lane of lanes) {
    const list = orderedByLane.get(lane.id) ?? [];
    const containerHeight = laneHeightById.get(lane.id) ?? baseLaneHeight;
    for (const node of list) {
      const column = columnByNode.get(node.id) ?? 0;
      const size = sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
      // Center the node within its column slot so wider/narrower
      // nodes still line up by their middle on the same x axis.
      const slotX = LANE_LABEL_WIDTH + LANE_CONTENT_LEFT_GUTTER + column * columnStep;
      const x = slotX + (maxNodeWidth - size.width) / 2;
      const center = rowCenterByNode.get(node.id) ?? containerHeight / 2;
      const y = center - size.height / 2;
      const laneY = laneYById.get(node.laneId) ?? 0;
      nodePositions.set(node.id, { x, y: laneY + y });
      flowNodes.push({
        id: node.id,
        type: nodeTypeForShape(node.shape),
        position: { x, y },
        parentId: laneNodeId(node.laneId),
        extent: "parent",
        data: {
          node,
          isCenter: (highlightFocal && node.id === centerId) || focusedNodeIds.has(node.id),
          isSubprocess: subprocessNodes.has(node.id),
        },
        draggable: false,
        selectable: false,
        connectable: false,
        initialWidth: size.width,
        initialHeight: size.height,
        style: {
          width: size.width,
          height: size.height,
          zIndex: 1,
          opacity: focalActive ? opacityForDepth(focalDepthByNode.get(node.id)) : 1,
        },
      });
    }
  }

  // Cross-process neighbours are NOT laid out in the swim lane. The renderer
  // draws them as boxes outside the pool (see `externalNeighbours` in the
  // component), so layout solves geometry from the focal pool's members only.

  const nodeSet = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Edge "bow" obstruction test. A roughly-horizontal edge whose straight
  // segment would pass through a node sitting between its endpoints is
  // arced (in the renderer) around that node. We compute it here, where
  // node geometry is known, so we only bow when a node ACTUALLY blocks
  // the path — and arc toward whichever side needs the smaller lift. An
  // edge threading the clear gap between stacked nodes is left straight.
  const edgeObstacleBoxes = nodes.flatMap((n) => {
    const p = nodePositions.get(n.id);
    if (!p) return [];
    const s = sizeByNode.get(n.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
    return [{ id: n.id, left: p.x, right: p.x + s.width, top: p.y, bottom: p.y + s.height }];
  });
  const boxById = new Map(edgeObstacleBoxes.map((b) => [b.id, b]));
  const computeEdgeBow = (
    sourceId: string,
    targetId: string,
  ): { dir: 1 | -1; lift: number } | null => {
    const s = boxById.get(sourceId);
    const t = boxById.get(targetId);
    if (!s || !t) return null;
    const sCy = (s.top + s.bottom) / 2;
    const tCy = (t.top + t.bottom) / 2;
    if (Math.abs(sCy - tCy) > 40) return null; // only roughly-horizontal edges
    const xa = s.right; // source's right handle
    const xb = t.left; // target's left handle
    if (xb - xa < 60) return null; // adjacent/overlapping: nothing between
    const yEdge = (sCy + tCy) / 2;
    const margin = 10;
    let minTop = Number.POSITIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;
    let blocked = false;
    for (const b of edgeObstacleBoxes) {
      if (b.id === sourceId || b.id === targetId) continue;
      if (b.right <= xa || b.left >= xb) continue; // outside the corridor
      if (yEdge > b.top - margin && yEdge < b.bottom + margin) {
        blocked = true;
        minTop = Math.min(minTop, b.top);
        maxBottom = Math.max(maxBottom, b.bottom);
      }
    }
    if (!blocked) return null;
    const apexUp = yEdge - minTop + margin + 6; // clear above the topmost blocker
    const apexDown = maxBottom - yEdge + margin + 6; // clear below the lowest
    const useUp = apexUp <= apexDown;
    const apex = Math.min(120, useUp ? apexUp : apexDown);
    // The cubic reaches ~3/4 of its control offset at the apex, so scale up.
    return { dir: useUp ? -1 : 1, lift: apex / 0.75 };
  };

  const flowEdges: FlowEdge[] = links
    .filter((link) => nodeSet.has(link.source) && nodeSet.has(link.target))
    .filter((link) => SEQUENCE_FLOW_EDGES.has(link.edge_type))
    .map((link, index) => {
      const source = link.source;
      const target = link.target;
      const edgeOpacity = focalActive
        ? opacityForEdge(focalDepthByNode.get(source), focalDepthByNode.get(target))
        : 1;
      // Edge inherits the origin node's lifecycle color so an
      // arrow visually "carries" the state of its source — drafted
      // work flows in yellow, active work in black, retired in red.
      const stroke = lifecycleColor(nodeById.get(link.source)?.lifecycle);
      const edgeData: Record<string, unknown> = {
        ...processEdgeLabelData(link.label, link.edge_type, stroke, edgeOpacity),
      };
      const bow = computeEdgeBow(source, target);
      if (bow) {
        edgeData.bowDir = bow.dir;
        edgeData.bowLift = bow.lift;
      }
      if (link.id) edgeData.graphLink = link;
      const isFocused = Boolean(focusedEdgeId && link.id === focusedEdgeId);
      const clickable = Boolean(link.id && link.href);
      const baseStrokeWidth = focalEdgeWidth(
        source,
        target,
        highlightFocal ? centerId : null,
        1.75,
      );
      return {
        id: link.id ?? `${link.source}-${link.target}-${index}`,
        source,
        target,
        // Bezier curves keep process arrows compact and soft; long edges
        // that would otherwise cut through intervening nodes are bowed
        // vertically by the renderer (see StableLabeledBezierEdge).
        type: "stableLabeledBezier",
        className: clickableEdgeClassName(clickable),
        zIndex: isFocused ? 3 : 0,
        data: Object.keys(edgeData).length > 0 ? edgeData : undefined,
        selectable: false,
        focusable: false,
        interactionWidth: clickable ? 18 : 0,
        style: {
          stroke,
          strokeWidth: isFocused ? Math.max(baseStrokeWidth, 5) : baseStrokeWidth,
          opacity: isFocused ? 1 : edgeOpacity,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: stroke,
        },
      };
    });

  const laneGeometry: ProcessLayout["lanes"] = lanes.map((lane) => {
    const y = laneYById.get(lane.id) ?? 0;
    const height = laneHeightById.get(lane.id) ?? baseLaneHeight;
    return { id: lane.id, pool_id: lane.pool_id, label: lane.label, y, height, kind: lane.kind };
  });

  return { flowNodes, flowEdges, nodePositions, lanes: laneGeometry, poolGeometry, laneWidth };
}

/**
 * Edge types that express BPMN sequence flow for layout and arrows.
 * `flows_to` is stored as a first-class edge in the same direction
 * it renders: source -> target. Association
 * edges (`supports`, `constrained_by`, `attributed_to`, …) remain visible
 * in detail panes, but they do not draw process arrows on this canvas.
 */
const SEQUENCE_FLOW_EDGES: ReadonlySet<string> = new Set(["flows_to"]);

function nodeTypeForShape(shape: ProcessShape): string {
  switch (shape) {
    case "circle":
      return "processCircle";
    case "diamond":
      return "processDiamond";
    case "document":
      return "processDocument";
    case "rounded":
      return "processRounded";
    case "task":
      return "processTask";
    case "milestone":
      return "processMilestone";
    default:
      return "processRectangle";
  }
}

function laneNodeId(laneId: string): string {
  return `lane:${laneId}`;
}

// Used by the outer container sizing — keeps the band-height knowledge
// in one place rather than scattering ternaries through the layout.
function heightForLane(lane: ProcessLane): number {
  if (lane.kind === "milestone") return MILESTONE_BAND_HEIGHT;
  if (lane.kind === "artifacts") return ARTIFACTS_BAND_HEIGHT;
  return LANE_HEIGHT;
}

// Lanes that map to a real Principal carry `kind: "actor"` (their
// base id is `principal_<ulid>`). Reference numbering and "keep on
// filter" treat actor lanes differently from synthetic bands /
// catchall lanes.
function isActorLane(lane: ProcessLane): boolean {
  return lane.kind === "actor";
}

// ─── Custom node components ────────────────────────────────────────

interface ProcessNodeData {
  node: ProcessNode;
  isCenter?: boolean;
  /** This Action is itself a process (it has `has_parent` children) — render
   *  the collapsed-subprocess "View subprocess" affordance. */
  isSubprocess?: boolean;
  /** A stand-in for a parent process this pool's Action hangs under, drawn
   *  above the pool. Clicking it drills into that parent's own pool. */
  isParentProcess?: boolean;
  /** Open this subprocess: expand its own pool and open its dialog (the "View
   *  subprocess" click). */
  onViewSubprocess?: (node: ProcessNode) => void;
}

interface ProcessLaneData {
  lane: ProcessLane;
  height: number;
  width: number;
  labelWidth: number;
  isCenter?: boolean;
  isMilestoneBand?: boolean;
  isArtifactsBand?: boolean;
  onLaneClick?: (lane: ProcessLane) => void;
}

interface ProcessPoolHeaderData {
  pool: ProcessPool;
  width: number;
  height: number;
  isCenter?: boolean;
}

function ProcessEdgeStubNode() {
  const style = {
    width: 1,
    height: 1,
    minWidth: 0,
    minHeight: 0,
    background: "transparent",
    border: "none",
    pointerEvents: "none" as const,
    opacity: 0,
  };
  return (
    <div style={style}>
      <Handle type="target" position={Position.Left} style={style} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={style} isConnectable={false} />
    </div>
  );
}

// Pool #N badge — same isolated store subscription as the lane and shape
// badges, keyed on the process Action id so re-numbering on pan never
// re-renders the whole header band. Only real process pools (non-null
// process_id) carry a number; the Unassigned pool gets none.
const ProcessPoolReferenceBadge = memo(function ProcessPoolReferenceBadge({
  processId,
  label,
}: {
  processId: string;
  label: string;
}) {
  const referenceNumber = useReferenceNumber(processId);
  if (!referenceNumber) return null;
  return (
    <span
      aria-label={`Graph reference #${referenceNumber}: ${label}`}
      className="pointer-events-none flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
      title={`Graph reference #${referenceNumber}`}
    >
      #{referenceNumber}
    </span>
  );
});

/**
 * Pool header band. Renders the process Action's prose as a banner across
 * the full canvas width above the pool's lanes. The Unassigned pool gets
 * a quieter neutral header so it doesn't compete visually with the
 * real process pools above it.
 */
export function ProcessPoolHeaderNode({ data }: { data: ProcessPoolHeaderData }) {
  const isUnassigned = data.pool.process_id === null;
  const bg = isUnassigned ? "rgba(0, 0, 0, 0.05)" : "rgba(40, 70, 160, 0.08)";
  const borderColor = isUnassigned ? "var(--color-border)" : "rgba(40, 70, 160, 0.35)";
  const topBorderWidth = data.isCenter ? 4 : 2;
  const bottomBorderWidth = data.isCenter ? 2 : 1;
  // Zoomed out far enough that the band's label and pills are illegible:
  // drop them so the pool reads as a plain tinted band, matching how the
  // shape nodes inside it simplify.
  const simplified = useProcessSimplified();
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        background: bg,
        borderTop: `${topBorderWidth}px solid ${borderColor}`,
        borderBottom: `${bottomBorderWidth}px solid ${borderColor}`,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 14px",
        boxSizing: "border-box",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0,
        color: isUnassigned ? "var(--color-muted-foreground, #525252)" : "#1f2937",
        cursor: !isUnassigned && data.pool.process_id ? "pointer" : undefined,
      }}
      // No hover tooltip once simplified — a bare band carries no label,
      // visible or on hover, just like the simplified shape nodes.
      title={simplified ? undefined : data.pool.label}
    >
      {simplified ? null : (
        <>
          {data.pool.process_id ? (
            <ProcessPoolReferenceBadge processId={data.pool.process_id} label={data.pool.label} />
          ) : null}
          {!isUnassigned && data.pool.process_id ? (
            <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
              <TypeBadge entityType="action" lifecycle={data.pool.lifecycle} anchor="inline" />
              <LifecycleBadge lifecycle={data.pool.lifecycle} anchor="inline" />
            </span>
          ) : null}
          <span
            className="overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ maxWidth: "100%" }}
          >
            {data.pool.label}
          </span>
        </>
      )}
      {/* Anchors for external-neighbour arrows that touch the process Action:
          they attach to the title band's left edge (entry) / right edge (exit).
          The top edge receives the dashed containment lines dropping from the
          parent processes drawn above the pool. */}
      <Handle
        id="pool-left"
        type="target"
        position={Position.Left}
        style={{ background: "transparent", border: "none" }}
      />
      <Handle
        id="pool-right"
        type="source"
        position={Position.Right}
        style={{ background: "transparent", border: "none" }}
      />
      <Handle
        id="pool-top"
        type="target"
        position={Position.Top}
        // Inset from the title's left edge rather than centered, so the dashed
        // parent arrows land near the left-aligned parent boxes above.
        style={{
          left: PARENT_LINK_TITLE_INSET,
          transform: "none",
          background: "transparent",
          border: "none",
        }}
      />
    </div>
  );
}

// Lane #N badge — same isolated store subscription as ProcessReferenceBadge,
// so re-numbering on pan never re-renders the whole lane band.
const ProcessLaneReferenceBadge = memo(function ProcessLaneReferenceBadge({
  laneId,
  label,
}: {
  laneId: string;
  label: string;
}) {
  const referenceNumber = useReferenceNumber(laneId);
  if (!referenceNumber) return null;
  return (
    <span
      aria-label={`Graph reference #${referenceNumber}: ${label}`}
      className="pointer-events-none absolute -left-2.5 top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
      title={`Graph reference #${referenceNumber}`}
    >
      #{referenceNumber}
    </span>
  );
});

export function ProcessLaneNode({ data }: { data: ProcessLaneData }) {
  // Zoomed out past the LOD threshold: collapse the lane to a plain
  // tinted band — drop the whole label column (label + #N badge +
  // type/lifecycle pills) so it simplifies in lockstep with the shape
  // nodes it holds.
  const simplified = useProcessSimplified();
  // The milestone band and the artifacts band are both phase / data
  // axes perpendicular to the actor lanes — render each with a
  // distinct tint and solid edges so they read as structurally
  // different from (and from each other) the swim lanes between them.
  const isBand = data.isMilestoneBand || data.isArtifactsBand;
  let bandBg = "rgba(0, 0, 0, 0.03)";
  let labelBg = "rgba(0, 0, 0, 0.04)";
  if (data.isMilestoneBand) {
    bandBg = "rgba(80, 110, 200, 0.07)";
    labelBg = "rgba(80, 110, 200, 0.12)";
  } else if (data.isArtifactsBand) {
    // Warm tint, distinct from the milestone band's cool blue.
    bandBg = "rgba(180, 130, 60, 0.07)";
    labelBg = "rgba(180, 130, 60, 0.13)";
  }
  const isClickableLane = isActorLane(data.lane) && Boolean(data.onLaneClick);
  const focusBorder = data.isCenter ? `4px solid ${lifecycleColor(data.lane.lifecycle)}` : null;
  const edge = isBand ? "1px solid var(--color-border)" : "1px dashed var(--color-border)";
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        background: bandBg,
        borderTop: edge,
        borderBottom: edge,
      }}
    >
      {simplified ? null : (
        <div
          className="relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            width: data.labelWidth,
            height: "100%",
            background: labelBg,
            border: focusBorder ?? undefined,
            borderRight: focusBorder ?? "1px solid var(--color-border)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontSize: 11,
            fontWeight: 600,
            textAlign: "center",
            padding: "0 8px",
            boxSizing: "border-box",
            textTransform: "none",
            letterSpacing: 0,
            cursor: isClickableLane ? "pointer" : undefined,
          }}
          onClick={
            isClickableLane
              ? (event) => {
                  event.stopPropagation();
                  data.onLaneClick?.(data.lane);
                }
              : undefined
          }
          onKeyDown={
            isClickableLane
              ? (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  data.onLaneClick?.(data.lane);
                }
              : undefined
          }
          role={isClickableLane ? "button" : undefined}
          tabIndex={isClickableLane ? 0 : undefined}
          title={data.lane.label}
        >
          <ProcessLaneReferenceBadge laneId={data.lane.id} label={data.lane.label} />
          <span>{data.lane.label}</span>
          <LaneBadgeRow lane={data.lane} />
        </div>
      )}
    </div>
  );
}

/**
 * Type + lifecycle badges above a lane's label, matching the badge
 * row at the top of every node card. Only actor lanes have a
 * single owning node (the Principal), so they get the type +
 * lifecycle pair. Bands (milestone / artifacts) are structural
 * containers that hold a set of nodes — labelling the band itself
 * with one of those node types is misleading, so we render nothing.
 */
function LaneBadgeRow({ lane }: { lane: ProcessLane }) {
  if (lane.kind !== "actor") return null;
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <TypeBadge entityType="principal" lifecycle={lane.lifecycle} anchor="inline" />
      <LifecycleBadge lifecycle={lane.lifecycle} anchor="inline" />
    </span>
  );
}

function ShapeLabel({ node }: { node: ProcessNode }) {
  // `position: relative` + zIndex puts this in the same paint tier as
  // sibling absolutely-positioned shape outlines (the SVG in the
  // Document shape, the rotated div in the Diamond), so DOM order
  // wins and the label paints OVER the fill instead of under it.
  return (
    <div
      className="pointer-events-none flex items-center justify-center px-2 text-center text-[10px] font-medium leading-tight"
      style={{
        width: "100%",
        height: "100%",
        color: "#1f1f1f",
        position: "relative",
        zIndex: 1,
      }}
      title={node.name ?? ""}
    >
      <span className="break-words">{node.name ?? <em>(unnamed)</em>}</span>
    </div>
  );
}

function commonHandles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: "transparent", border: "none" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: "transparent", border: "none" }}
      />
    </>
  );
}

// Subscribe each shape to a *boolean* derived from the live zoom: true
// once the canvas is zoomed out far enough that labels/badges are
// illegible. Selecting on the boolean (not the raw zoom) means a shape
// re-renders at most once as a zoom gesture crosses PROCESS_LOD_ZOOM, and
// never during a constant-zoom pan — so the LOD switch itself costs
// nothing on the frames that matter. Below the threshold the shape drops
// its label, badges, and shadow and pans as a plain bordered box.
function useProcessSimplified(): boolean {
  return useStore((s) => processSimplifiedAtZoom(s.transform[2]));
}

function processStrokeWidth(data: ProcessNodeData, baseWidth = 2): number {
  return data.isCenter ? baseWidth * 2 : baseWidth;
}

function processBorder(data: ProcessNodeData, stroke: string, baseWidth = 2): string {
  return `${processStrokeWidth(data, baseWidth)}px solid ${stroke}`;
}

export function ProcessRectangleNode({ data }: { data: ProcessNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  const simplified = useProcessSimplified();
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: processBorder(data, stroke),
        borderRadius: 4,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: simplified ? undefined : "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} />}
      {simplified ? null : <ShapeLabel node={data.node} />}
      {commonHandles()}
    </div>
  );
}

// Stadium pill — the State glyph. A State is a milestone/outcome (a
// condition that holds), so its fully-rounded silhouette reads as
// distinct from the Action's task rectangle even at low zoom, while
// staying full-sized and legible. (Ideas, the former pill, are not
// process content — barred by the process node-type
// allowlist — so the pill is the State's alone.)
function ProcessRoundedNode({ data }: { data: ProcessNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  const simplified = useProcessSimplified();
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: processBorder(data, stroke),
        borderRadius: 28,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: simplified ? undefined : "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} />}
      {simplified ? null : <ShapeLabel node={data.node} />}
      {commonHandles()}
    </div>
  );
}

// The "View subprocess" affordance on a collapsed subprocess Action (OMG BPMN
// 2.0 §10.2.4: a collapsed sub-process is a task glyph with a drill-in marker).
// It sits inside the box's reserved bottom strip, centered, lifted clear of the
// type/lifecycle badge row that straddles the edge below it. Clicking it expands
// the subprocess into its own pool (a different swim-lane view) — and ONLY this
// button does: a plain click on the Action body focuses it where it sits.
// Hidden under LOD (zoomed out, the label strip is illegible anyway).
function ViewSubprocessButton({
  data,
  stroke,
  hidden = false,
}: {
  data: ProcessNodeData;
  stroke: string;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <button
      type="button"
      // Stop the click from also bubbling to React Flow's onNodeClick — both
      // open the subprocess, so without this the node would open twice.
      onClick={(event) => {
        event.stopPropagation();
        data.onViewSubprocess?.(data.node);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      // `.neu-pill-button` paints the raised → pressed neumorphic shadow so the
      // pill reads as a real button; `nodrag nopan` keeps a click on it from
      // panning the canvas. It sits in the bottom strip the node reserves,
      // lifted clear of the type/lifecycle badge row straddling the edge below.
      className="nodrag nopan neu-pill-button"
      style={{
        position: "absolute",
        bottom: SUBPROCESS_BUTTON_BOTTOM,
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "calc(100% - 12px)",
        boxSizing: "border-box",
        background: "#fff",
        border: "1px solid var(--neu-border)",
        borderRadius: 5,
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "2px 7px",
        fontSize: 9,
        lineHeight: 1.35,
        fontWeight: 600,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        color: stroke,
        cursor: "pointer",
        zIndex: 3,
      }}
    >
      <span aria-hidden="true">⊞</span> View subprocess
    </button>
  );
}

// BPMN Task — rounded rectangle. Sits between the sharp Rectangle (a
// policy box) and the fully-pill Rounded (the State stadium); the radius
// matches the OMG BPMN 2.0 task glyph. When the Action is itself a process
// it wears the collapsed-subprocess "View subprocess" affordance.
function ProcessTaskNode({ data }: { data: ProcessNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  const simplified = useProcessSimplified();
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: processBorder(data, stroke),
        borderRadius: 12,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: simplified ? undefined : "0 1px 2px rgba(0,0,0,0.04)",
        // Reserve a matching strip top and bottom: the bottom keeps the centered
        // label clear of the "View subprocess" affordance, the top mirrors it so
        // the label stays centered rather than pushed up. The layout grew the
        // box by 2× this; border-box keeps the padding inside that box.
        paddingTop: data.isSubprocess ? SUBPROCESS_MARKER_ROOM : undefined,
        paddingBottom: data.isSubprocess ? SUBPROCESS_MARKER_ROOM : undefined,
        boxSizing: data.isSubprocess ? "border-box" : undefined,
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} />}
      {simplified ? null : <ShapeLabel node={data.node} />}
      {commonHandles()}
      {/* A parent-process box drops a dashed containment line from its bottom
          edge down to the pool it sits over (see `parentProcesses`). */}
      {data.isParentProcess ? (
        <Handle
          id="parent-link-bottom"
          type="source"
          position={Position.Bottom}
          style={{ background: "transparent", border: "none" }}
        />
      ) : null}
      {data.isSubprocess ? (
        <ViewSubprocessButton data={data} stroke={stroke} hidden={simplified} />
      ) : null}
    </div>
  );
}

// Milestone — compact labeled box. Lives in the milestone band above
// the swim lanes; the band's tinted background does most of the visual
// work, so the node itself is intentionally subdued (thin border,
// uppercase compact label) so a row of milestones reads as a phase
// timeline rather than a row of flow shapes.
function ProcessMilestoneNode({ data }: { data: ProcessNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  const simplified = useProcessSimplified();
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: processBorder(data, stroke, 1),
        borderRadius: 4,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 8px",
        boxSizing: "border-box",
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} />}
      {simplified ? null : (
        <span
          className="pointer-events-none break-words text-center text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: "#1f1f1f", letterSpacing: 0.4 }}
          title={data.node.name ?? ""}
        >
          {data.node.name ?? <em>(unnamed)</em>}
        </span>
      )}
      {commonHandles()}
    </div>
  );
}

function ProcessCircleNode({ data }: { data: ProcessNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  const simplified = useProcessSimplified();
  // Circle fills the React Flow box (sized per-node via sizeForNode
  // upstream). Because the box is squared for circles, border-radius:50%
  // gives a true round shape; longer summaries grow the box and the
  // circle scales accordingly.
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} circular />}
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#fff",
          border: processBorder(data, stroke),
          borderRadius: "50%",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: simplified ? undefined : "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        {simplified ? null : <ShapeLabel node={data.node} />}
      </div>
      {commonHandles()}
    </div>
  );
}

function ProcessDiamondNode({ data }: { data: ProcessNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  const simplified = useProcessSimplified();
  // The diamond fills the full React Flow box so gateways line up
  // visually with Task rectangles. For a non-square box that means
  // an elongated rhombus rather than a perfect diamond — acceptable
  // by design so process columns share one horizontal rhythm.
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} />}
      <svg
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          // The SVG drop-shadow filter is a per-frame compositing cost;
          // drop it (with the rest of the detail) when zoomed out.
          filter: simplified ? undefined : "drop-shadow(0 1px 2px rgba(0,0,0,0.04))",
          pointerEvents: "none",
        }}
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        <polygon
          points="50,2 98,50 50,98 2,50"
          fill="#fff"
          stroke={stroke}
          strokeWidth={processStrokeWidth(data)}
        />
      </svg>
      {simplified ? null : (
        <div
          style={{
            position: "relative",
            width: "60%",
            height: "60%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ShapeLabel node={data.node} />
        </div>
      )}
      {commonHandles()}
    </div>
  );
}

function ProcessDocumentNode({ data }: { data: ProcessNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  const simplified = useProcessSimplified();
  // The "document" look — rectangle with a wavy bottom edge. We draw
  // it as inline SVG behind the label so the shape stays crisp at any
  // zoom.
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} />}
      <svg
        viewBox="0 0 140 60"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      >
        <path
          d="M2,2 H138 V48 Q120,62 100,50 Q80,38 60,50 Q40,62 20,50 Q10,44 2,48 Z"
          fill="#fff"
          stroke={stroke}
          strokeWidth={processStrokeWidth(data)}
        />
      </svg>
      {simplified ? null : <ShapeLabel node={data.node} />}
      {commonHandles()}
    </div>
  );
}

function graphReferenceAttributes(
  data: ProcessNodeData,
): Record<string, string | number | undefined> {
  // The #N reference number is intentionally not emitted here. It lives in
  // the reference-number store (subscribed per-badge) rather than node
  // `data`, so a focus change that renumbers never has to rebuild the node
  // objects. The sidebar reads numbering from the *published* references
  // (usePublishedReferences), which is the canonical source; this DOM
  // attribute was only a fallback for perspectives that don't publish.
  //
  // `cursor-pointer`: every shape is clickable (onNodeClick re-focuses the
  // process around it). React Flow paints `cursor: default` on the node
  // wrapper unless the node is `selectable`, which we opt out of — so the
  // shape's own root has to declare the pointer affordance. This is the one
  // place every shape root shares, so it lands the cursor on all of them.
  return {
    className: "cursor-pointer",
    "data-node-href": data.node.href ?? undefined,
    "data-node-id": data.node.id,
    "data-node-label": data.node.name ?? data.node.id,
    "data-node-lifecycle": data.node.lifecycle ?? "active",
    "data-node-type": data.node.entity_type,
  };
}

// Subscribes to just this node's #N from the reference-number store, so
// only the badge re-renders when the numbering shifts (e.g. while
// panning) — never the surrounding shape (border, handles, SVG, label).
const ProcessReferenceBadge = memo(function ProcessReferenceBadge({
  nodeId,
  label,
}: {
  nodeId: string;
  label: string;
}) {
  const referenceNumber = useReferenceNumber(nodeId);
  return <ReferenceNumberBadge referenceNumber={referenceNumber} referenceLabel={label} />;
});

/**
 * Tag row floated centered over the TOP edge of a BPMN shape (type
 * pill + lifecycle pill) and reference-number badge centered over the
 * BOTTOM edge. Shared with the Graph perspective via
 * `~/components/node-badges` so both perspectives read the same.
 *
 * `circular` is preserved as a no-op anchor hint — the new layout is
 * already top-center for every shape, so circles don't need a special
 * anchor — but kept on the prop so any caller that still passes it
 * doesn't break.
 */

// The entry/exit flow point, drawn as a vertical tag clipped to the node's
// side. It gets the same pill treatment as the type/lifecycle badges
// (lifecycle color via `badgeStyle`), just stood on its side: Entry rides the
// LEFT edge reading bottom-to-top (rotate -90°), the way flow enters; Exit
// rides the RIGHT edge reading top-to-bottom (rotate 90°), the way it leaves.
// Each carries the BPMN event ring — thin = start, thick = end.
function FlowPointPill({
  kind,
  lifecycle,
}: {
  kind: "entry" | "exit";
  lifecycle: string | null | undefined;
}) {
  const onLeft = kind === "entry";
  const fg = textOnLifecycle(lifecycle);
  return (
    <span
      className="pointer-events-none"
      style={{
        ...badgeStyle(lifecycle, "inline"),
        position: "absolute",
        top: "50%",
        left: onLeft ? 0 : undefined,
        right: onLeft ? undefined : 0,
        // Center the horizontal pill on the edge, then stand it up. Entry
        // reads bottom-to-top, Exit top-to-bottom.
        transform: `translate(${onLeft ? "-50%" : "50%"}, -50%) rotate(${onLeft ? "-90deg" : "90deg"})`,
        transformOrigin: "center",
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        zIndex: 2,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          flexShrink: 0,
          borderRadius: "50%",
          // Thin ring = BPMN start event; thick ring = BPMN end event.
          border: `${kind === "exit" ? 2 : 1}px solid ${fg}`,
          boxSizing: "border-box",
        }}
      />
      {onLeft ? "Entry" : "Exit"}
    </span>
  );
}

function ProcessFlowPointTag({ node }: { node: ProcessNode }) {
  return (
    <>
      {node.entry_point === true ? <FlowPointPill kind="entry" lifecycle={node.lifecycle} /> : null}
      {node.exit_point === true ? <FlowPointPill kind="exit" lifecycle={node.lifecycle} /> : null}
    </>
  );
}

function ProcessBadgeRow({ data }: { data: ProcessNodeData; circular?: boolean }) {
  return (
    <>
      <NodeBadgeRow
        entityType={data.node.entity_type}
        lifecycle={data.node.lifecycle}
        className="nodrag nopan"
        interactive
      />
      <ProcessReferenceBadge nodeId={data.node.id} label={data.node.name ?? data.node.id} />
      <ProcessFlowPointTag node={data.node} />
    </>
  );
}
