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
} from "~/components/node-badges";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { StandardControls } from "~/components/perspective-canvas-overlays";
import { StableLabeledBezierEdge } from "~/components/stable-labeled-edge";
import { summarizeExternalConnections } from "~/lib/focused-render-selection";
import {
  computeDepthFromCenter,
  focalEdgeWidth,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import type { GraphReferenceItem } from "~/lib/graph-references";
import { lifecycleColor } from "~/lib/node-colors";
import { perspectiveCountLabel } from "~/lib/perspective-count";
import { usePerspectiveReferences } from "~/lib/perspective-references";
import { processEdgeLabelStyles } from "~/lib/process-edge-label-style";
import { topEntryPointId } from "~/lib/process-entry-points";
import { processFocusFlowNodeId, processPoolFitNodeIds } from "~/lib/process-focus-fit";
import { packProcessLaneColumns, processLaneColumnKey } from "~/lib/process-lane-packing";
import { processSimplifiedAtZoom } from "~/lib/process-lod";
import { layoutAdjacentNodes } from "~/lib/process-outside-layout";
import type {
  ProcessLane,
  ProcessNode,
  ProcessPool,
  ProcessShape,
} from "~/lib/process-perspective.server";
import { processPriorityReferences } from "~/lib/process-references";
import { computeForwardSequenceDepths } from "~/lib/process-sequence-depth";
import { indexById, reuseStableNodes } from "~/lib/process-stable-nodes";
import { subprocessTargetIntents } from "~/lib/process-subprocess";
import { topLevelIntentPools } from "~/lib/process-top-level-intents";
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

interface ProcessPerspectiveProps {
  docoHandle?: string | null;
  /**
   * One pool per Intent in the Doco (plus an "Unassigned" pool for
   * nodes that don't cite an Intent). Pools are rendered in the
   * order given — the server emits them sorted by descending global
   * PageRank, with the Unassigned pool pinned to the bottom.
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
  /** TRUE total of BPMN flow nodes (steps) before the server cap — drives the
   *  "Showing the latest N of M steps" overlay. Defaults to `nodes.length`. */
  totalCount?: number;
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
   * Picking a process from the home list focuses that Intent. The host
   * uses this to reflect the focus in the URL (a focus-only `/intent/<id>`
   * link), so the view is shareable and the Back button works.
   */
  onIntentOpen?: (intentId: string) => void;
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
const NODE_GAP_X = 60;
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
  const PAD_Y = 16;
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

export function ProcessPerspective({
  docoHandle,
  pools,
  lanes: lanesRaw,
  nodes: nodesRaw,
  totalCount,
  links: linksRaw,
  onNodeClick,
  onPoolClick,
  onLaneClick,
  onCenterChange,
  onPaneClick,
  onIntentOpen,
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
  // The BPMN perspective opens on a list of the Doco's top-level processes
  // (the "home" view) rather than drilling straight into one pool. An
  // explicit camera focus — a node URL, an agent auto-focus, a panel open —
  // skips the list and drills in. Picking a process from the list, or
  // arriving via such a focus, switches to the swim-lane canvas; the Home
  // button returns to the list.
  const [homeMode, setHomeMode] = useState<boolean>(() => !initialFocusId);
  useEffect(() => {
    if (initialFocusId) setHomeMode(false);
  }, [initialFocusId]);
  // Reset the one-shot camera-fit machinery so the next drill-in (after the
  // canvas remounts coming out of the list) frames its process afresh.
  const goHome = useCallback(() => {
    hasFitRef.current = false;
    flowInstanceRef.current = null;
    defaultFocusAppliedRef.current = false;
    initialFocusAppliedRef.current = null;
    setHomeMode(true);
    onHomeReset?.();
  }, [onHomeReset]);
  const openIntent = useCallback(
    (intentId: string) => {
      setHomeMode(false);
      onCenterChange?.(intentId);
      onIntentOpen?.(intentId);
    },
    [onCenterChange, onIntentOpen],
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

  // Drop nodes whose lifecycle is filtered out. Lanes are never
  // dropped once the server emits them, so a filtered-out Action
  // does not make its swim lane disappear. Links are still filtered
  // by the existing nodeSet check inside layOutProcess.
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
      (nodeByFullId.has(centerId) || pools.some((pool) => pool.intent_id === centerId))
    ) {
      return centerId;
    }
    return null;
  }, [centerId, nodeByFullId, pools]);
  // Cold-open default (no node in the URL): the first pool's entry point.
  // Pools arrive oldest-first from the server, so this lands on the start
  // of the oldest process — deterministic, no PageRank.
  const defaultCenterId = useMemo(
    () => pools.find((pool) => pool.intent_id)?.intent_id ?? filteredNodes[0]?.id ?? null,
    [pools, filteredNodes],
  );
  const selectionCenterId = useMemo(
    () => focusCenterId ?? defaultCenterId ?? centerId ?? null,
    [focusCenterId, defaultCenterId, centerId],
  );
  // The home view's clickable directory: every top-level process. Computed
  // from the full node set (not the lifecycle-filtered one) so hiding a
  // lifecycle never reclassifies a process as a sub-process, then filtered
  // for display so a hidden-lifecycle Intent drops out of the list too.
  const listPools = useMemo(() => {
    const top = topLevelIntentPools(pools, nodes);
    if (!visibleLifecycles) return top;
    return top.filter((pool) => visibleLifecycles.has(pool.lifecycle ?? "active"));
  }, [pools, nodes, visibleLifecycles]);
  useEffect(() => {
    if (!centerId || focusCenterId || !selectionCenterId || selectionCenterId === centerId) return;
    onCenterChange?.(selectionCenterId);
  }, [centerId, focusCenterId, selectionCenterId, onCenterChange]);
  const focusedNodeIdSet = useMemo(() => new Set(focusedNodeIds ?? []), [focusedNodeIds]);

  // Focusing an Intent doesn't fan out its whole swim lane — it homes in on
  // the intent's "way in", the earliest-created entry point of its pool, and
  // focuses that node. `resolveIntentToEntry` maps any intent-center to that
  // node; a center that is already a node (or an intent with no entry point
  // in the visible set) passes through unchanged.
  const resolveIntentToEntry = useCallback(
    (id: string | null | undefined): string | null => {
      if (!id) return null;
      const pool = pools.find((candidate) => candidate.intent_id === id);
      if (!pool) return id;
      return topEntryPointId(pool.id, filteredNodes, links) ?? id;
    },
    [pools, filteredNodes, links],
  );
  // The single node the view is focused on. Always defined (falls back to
  // the first pool's entry point), because the BPMN perspective always
  // frames one focal node and the one swim lane that owns it.
  const effectiveCenterId = useMemo(
    () => resolveIntentToEntry(selectionCenterId),
    [resolveIntentToEntry, selectionCenterId],
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
        focusedEdgeId: focusedEdgeId ?? null,
        focusedNodeIds: focusedNodeIdSet,
      }),
    [filteredNodes, pools, links, effectiveCenterId, focusedEdgeId, focusedNodeIdSet],
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
  // intent URL) frames the entire pool without singling out any node — so the
  // depth-fade + focal highlight are suppressed. Focusing a specific node
  // (clicking a shape) still highlights it. `selectionCenterId` is the Intent
  // id in the former case and a node id in the latter.
  const isIntentFocus = useMemo(
    () => pools.some((pool) => pool.intent_id === selectionCenterId),
    [pools, selectionCenterId],
  );
  // A cross-intent edge frames two whole intents; singling out one focal
  // node with a depth-fade would wash the *other* intent out, so suppress
  // it. The two edge endpoints are still highlighted via `focusedNodeIds`.
  const highlightFocal = !isIntentFocus && focalPoolIds.size <= 1;
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
      if (!pool.intent_id) return;
      if (onCenterChange) onCenterChange(pool.intent_id);
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

  // The Intent pool and its principal-owned swimlanes are first-class
  // references — they take the leading numbers (Intent first, then each
  // swimlane owner, in top-to-bottom reading order) before any shape, so a
  // viewer can jump from the sidebar straight to the pool or lane owner.
  // Passed to the shared hook as `priorityItems`; the hook handles every
  // shape node's numbering (sort, viewport-cull, cap, registry publish).
  const priorityReferences = useMemo<GraphReferenceItem[]>(
    () => processPriorityReferences(renderedPools, renderedLanes, docoHandle),
    [renderedPools, renderedLanes, docoHandle],
  );
  const nodeReferenceCandidates = useMemo(
    () =>
      renderedNodes.flatMap((node) => {
        const position = layout.nodePositions.get(node.id);
        if (!position) return [];
        const size = sizeForNode(node);
        return [
          {
            id: node.id,
            entity_type: node.entity_type,
            label: node.name ?? node.id,
            lifecycle: node.lifecycle ?? "active",
            href: node.href ?? null,
            position,
            width: size.width,
            height: size.height,
          },
        ];
      }),
    [renderedNodes, layout.nodePositions],
  );
  const { numberById: referenceNumberByEntityId } = usePerspectiveReferences({
    source: "process",
    viewport,
    size: graphSize,
    candidates: nodeReferenceCandidates,
    priorityItems: priorityReferences,
  });
  // Publish the numbering into an external store so each #N badge can
  // subscribe to its own number. Keeping the number out of node `data`
  // is what lets `flowNodes` stay referentially stable across pans — the
  // numbers shift on every frame, the node objects no longer do.
  const referenceNumberStore = useRef(createReferenceNumberStore()).current;
  useEffect(() => {
    referenceNumberStore.setNumbers(referenceNumberByEntityId);
  }, [referenceNumberByEntityId, referenceNumberStore]);

  const externalEdgeStubs = useMemo(() => {
    const summaries = summarizeExternalConnections(links, renderedNodeIds, filteredNodeIds);
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let stubIndex = 0;

    const addStub = (
      anchorNode: ProcessNode,
      direction: "incoming" | "outgoing",
      count: number,
      summaryIndex: number,
    ) => {
      if (stubIndex >= PROCESS_PLACEHOLDER_STUB_BUDGET) return;
      const position = layout.nodePositions.get(anchorNode.id);
      if (!position) return;
      const size = sizeForNode(anchorNode);
      const id = `process-placeholder:${direction}:${anchorNode.id}`;
      const directionSign = direction === "incoming" ? -1 : 1;
      const distance = 132 + (summaryIndex % 3) * 12;
      const y = position.y + size.height / 2;
      const x = LANE_LEFT_INSET + position.x + size.width / 2 + directionSign * distance;
      const matchingLink = links.find(
        (link) =>
          filteredNodeIds.has(link.source) &&
          filteredNodeIds.has(link.target) &&
          (direction === "incoming"
            ? link.target === anchorNode.id && !renderedNodeIds.has(link.source)
            : link.source === anchorNode.id && !renderedNodeIds.has(link.target)),
      );
      const colorNode =
        direction === "incoming" ? nodeByFullId.get(matchingLink?.source ?? "") : anchorNode;
      const stroke = lifecycleColor((colorNode ?? anchorNode).lifecycle);

      nodes.push({
        id,
        type: "processEdgeStub",
        position: { x, y },
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
        id: `process-placeholder-edge:${direction}:${anchorNode.id}`,
        source: direction === "incoming" ? id : anchorNode.id,
        target: direction === "incoming" ? anchorNode.id : id,
        type: "fadingPlaceholder",
        data: {
          color: stroke,
          direction,
          fadePx: 100,
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
      const anchor = nodeById.get(summary.id);
      if (!anchor) return;
      if (summary.outgoing > 0) addStub(anchor, "outgoing", summary.outgoing, index);
      if (summary.incoming > 0) addStub(anchor, "incoming", summary.incoming, index);
    });

    return { nodes, edges };
  }, [links, renderedNodeIds, filteredNodeIds, layout.nodePositions, nodeById, nodeByFullId]);

  // Sub-process drill-down links. The "+" marker and its reserved room
  // are decided in layOutProcess (stable, data-level, rides on the node's
  // `data.isSubprocess`). Here we build only the dashed links, which are
  // render-gated: one per rendered Action → each served Intent whose
  // pool header is actually mounted, so a link never dangles off-screen.
  const subprocessEdges = useMemo<FlowEdge[]>(() => {
    const renderedIntentPools = new Set<string>();
    const headerIdByIntent = new Map<string, string>();
    for (const pool of renderedPools) {
      if (!pool.intent_id) continue;
      renderedIntentPools.add(pool.intent_id);
      headerIdByIntent.set(pool.intent_id, `pool-header:${pool.id}`);
    }
    const edges: FlowEdge[] = [];
    for (const node of renderedNodes) {
      const targets = subprocessTargetIntents(node, renderedIntentPools);
      for (const intentId of targets) {
        const headerId = headerIdByIntent.get(intentId);
        if (!headerId) continue;
        edges.push({
          id: `subprocess:${node.id}->${intentId}`,
          source: node.id,
          sourceHandle: SUBPROCESS_SOURCE_HANDLE,
          target: headerId,
          targetHandle: SUBPROCESS_TARGET_HANDLE,
          // "default" is xyflow's built-in bezier edge (always
          // registered); we don't need the custom labeled-bezier type.
          type: "default",
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          style: {
            stroke: SUBPROCESS_EDGE_COLOR,
            strokeWidth: 1.5,
            strokeDasharray: "6 4",
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: SUBPROCESS_EDGE_COLOR,
          },
        });
      }
    }
    return edges;
  }, [renderedNodes, renderedPools]);

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
      return [{ ...node, className }];
    });
    // Reuse last render's object identity for any node whose render inputs
    // are unchanged, so the memo'd shape components skip work when a focus
    // shift re-runs the layout. (On pan this memo doesn't recompute at
    // all — none of its deps depend on the viewport anymore.)
    const built = [...windowed, ...externalEdgeStubs.nodes];
    const stable = reuseStableNodes(built, prevFlowNodesRef.current);
    prevFlowNodesRef.current = indexById(stable);
    return stable;
  }, [
    layout.flowNodes,
    renderedLaneIds,
    renderedPoolIds,
    renderedNodeIds,
    openLaneNode,
    externalEdgeStubs.nodes,
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
      ...externalEdgeStubs.edges,
      ...subprocessEdges,
    ],
    [layout.flowEdges, renderedNodeIds, externalEdgeStubs.edges, subprocessEdges],
  );
  // Initial focus: an explicit URL focus wins; otherwise fall back to the
  // selection center (highest global PageRank in the BPMN view) so opening
  // the perspective centers on the most important node, matching the
  // overview graph's behavior.
  const initialFocusFlowNodeId = useMemo(() => {
    const rawTarget = initialFocusId ?? selectionCenterId;
    if (!rawTarget) return null;
    const flowNodeIds = new Set(flowNodes.map((node) => node.id));
    // An *intent* focus frames the WHOLE pool (its header, which the fit then
    // expands to header + lanes), not just the entry step; a *node* focus
    // frames that node.
    const poolIdByIntentId = new Map<string, string>();
    for (const candidate of pools) {
      if (candidate.intent_id) poolIdByIntentId.set(candidate.intent_id, candidate.id);
    }
    const direct = processFocusFlowNodeId(rawTarget, poolIdByIntentId, flowNodeIds);
    if (direct) return direct;
    // Degenerate fallbacks: an intent whose pool header isn't rendered drops
    // to its entry point; an actor-lane target frames that lane.
    const target = resolveIntentToEntry(rawTarget);
    if (target && flowNodeIds.has(target)) return target;
    const lane = renderedLanes.find((candidate) => candidate.base_id === target);
    if (lane) {
      const id = laneNodeId(lane.id);
      if (flowNodeIds.has(id)) return id;
    }
    return null;
  }, [flowNodes, initialFocusId, selectionCenterId, resolveIntentToEntry, pools, renderedLanes]);

  // Apply the one-shot initial/default camera focus. A pool target fits the
  // WHOLE pool (header + its lanes) so the camera frames the entire process
  // instead of centering on the pool's full-width header band; any other
  // target zooms to that single node at 100%.
  const fitInitialFocus = useCallback(
    (instance: FlowInstance, targetId: string) => {
      const flowNodeIds = new Set(flowNodes.map((node) => node.id));
      const poolFit = processPoolFitNodeIds(targetId, renderedLanes, laneNodeId, flowNodeIds);
      instance.fitView?.(
        poolFit && poolFit.length > 0
          ? { nodes: poolFit.map((id) => ({ id })), padding: 0.15, maxZoom: 1, duration: 0 }
          : { nodes: [{ id: targetId }], padding: 0, minZoom: 1, maxZoom: 1, duration: 0 },
      );
      const current = instance.getViewport?.();
      if (current) updateViewport(current);
    },
    [flowNodes, renderedLanes, updateViewport],
  );

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

  // Home view: the directory of top-level processes. Rendered instead of
  // the swim-lane canvas so the canvas (and its Home button) only mount
  // once the viewer has drilled into a process — coming back out resets
  // the fit machinery (goHome) so the next pick frames its pool afresh.
  // A Doco with no top-level Intents (e.g. only Unassigned work) has
  // nothing to list, so it falls through to the canvas as before.
  if (homeMode && listPools.length > 0) {
    return (
      <div ref={graphRef} className="relative h-full w-full">
        <ProcessProcessList pools={listPools} onSelect={openIntent} />
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
      {/* Dataset count overlay — honest about the server cap. Describes the
          delivered steps vs the true total, independent of the lifecycle
          filter and the render-window viewport. */}
      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded bg-card/80 px-2 py-1 text-xs tabular-nums text-muted-foreground backdrop-blur-sm">
        {perspectiveCountLabel(
          { loaded: nodesRaw.length, total: totalCount ?? nodesRaw.length },
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
            onNodeClick={(_e: unknown, node: { id: string }) => {
              const pool = poolByHeaderId.get(node.id);
              if (pool) {
                openPoolNode(pool);
                return;
              }
              const target = nodeById.get(node.id);
              if (!target) return;
              // Make the clicked node the new focal node. If it belongs to
              // another intent (an adjacent neighbour), this resets the whole
              // render: its pool becomes the drawn swim lane.
              if (onCenterChange) onCenterChange(target.id);
              if (onNodeClick) {
                onNodeClick(target);
                return;
              }
              if (target.href) navigate(target.href);
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
            const isUnassigned = pool.intent_id === null;
            const sourcePool = poolById.get(pool.id);
            const isClickablePool = !isUnassigned && Boolean(sourcePool?.intent_id);
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
            const referenceNumber = pool.intent_id
              ? referenceNumberByEntityId.get(pool.intent_id)
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

/**
 * The BPMN home view: a clickable directory of the Doco's top-level
 * processes (always at least one — the caller renders the canvas instead
 * when there are none). Picking one focuses that Intent so the canvas
 * drills into its swim-lane process. Reads as "the list of processes you
 * can dive into," the BPMN analogue of the graph's fit-to-everything
 * default.
 */
export function ProcessProcessList({
  pools,
  onSelect,
}: {
  pools: ProcessPool[];
  onSelect: (intentId: string) => void;
}) {
  return (
    // Center the directory both ways inside the frame. `my-auto` (not
    // `items-center`) vertically centers a short list while still letting a
    // tall one scroll from the top without clipping its first rows.
    <div className="flex h-full w-full justify-center overflow-auto p-6">
      {/* No standalone "Processes" heading — each row carries its own
          identity inline, the way a pool header does. The list keeps its
          accessible name via aria-label so the visible title can go. */}
      <ul className="my-auto flex w-full max-w-md flex-col gap-1.5" aria-label="Processes">
        {pools.map((pool) => {
          const intentId = pool.intent_id;
          if (!intentId) return null;
          const lifecycle = pool.lifecycle ?? "active";
          return (
            <li key={pool.id}>
              <button
                type="button"
                onClick={() => onSelect(intentId)}
                // Mirrors ProcessPoolHeaderNode: the type + lifecycle pills sit
                // inline before the label, vertically centered in the row —
                // sewn into the band rather than pinned to its top corners.
                className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm shadow-sm transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <TypeBadge entityType="intent" lifecycle={lifecycle} anchor="inline" />
                <LifecycleBadge lifecycle={lifecycle} anchor="inline" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {pool.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
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
    intent_id: string | null;
    lifecycle: string | null;
  }>;
}

const POOL_HEADER_HEIGHT = 32;
const POOL_GAP = 16;
// Vertical gap between the drawn swim lane and the row of adjacent
// cross-intent neighbours sitting above or below it (see layOutProcess).
const ADJACENT_POOL_GAP = 80;

// Sub-process drill-down link. An Action that `serves` an Intent other
// than its own pool's is a BPMN collapsed sub-process: it stands in for
// that Intent's whole process. We mark the Action with a "+" glyph and
// draw a dashed link from that marker up to the sub-process Intent's
// pool header. Slate (not lifecycle-colored) so it reads as a
// structural drill-down rather than process flow; the handle ids keep
// it distinct from the id-less sequence-flow handles on every shape.
const SUBPROCESS_EDGE_COLOR = "#64748b"; // slate-500
const SUBPROCESS_SOURCE_HANDLE = "subprocess";
const SUBPROCESS_TARGET_HANDLE = "subprocess-in";
// Vertical room reserved at the bottom of a sub-process Action so the
// "+" marker sits inside the box without colliding with the label. The
// layout grows the node by this much; the node component pads its label
// area by the same amount so text never enters the marker strip.
const SUBPROCESS_MARKER_ROOM = 20;

// The exact node set the BPMN perspective draws for a given focus, and the
// pool(s) those nodes belong to. The rule:
//
//   • Focusing a node (or an edge whose endpoints share one intent) frames
//     that one intent — every node in its pool — plus the focal node's
//     first-degree cross-intent sequence-flow neighbours (drawn adjacent to
//     the lane).
//   • Focusing an edge whose endpoints live in *two different intents*
//     frames BOTH intents in full — every node of each pool — so the
//     hand-off is shown in the context of both processes it joins.
//
// Returns the focal pool ids (one for a single-intent focus, two for a
// cross-intent edge) and the full set of node ids to render.
export function computeProcessRenderedSet(params: {
  nodes: ProcessNode[];
  pools: ProcessPool[];
  links: OverviewGraphLink[];
  centerId: string | null | undefined;
  focusedEdgeId: string | null;
  focusedNodeIds: ReadonlySet<string>;
}): { focalPoolIds: Set<string>; renderedNodeIds: Set<string> } {
  const { nodes, pools, links, centerId, focusedEdgeId, focusedNodeIds } = params;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const focalPoolIds = new Set<string>();
  // The focal node's own pool — also handles an intent-center that never
  // resolved to a node (its pool matched by intent_id).
  if (centerId) {
    const fromIntent = pools.find((pool) => pool.intent_id === centerId)?.id;
    const centerPoolId = fromIntent ?? nodeById.get(centerId)?.pool_id ?? null;
    if (centerPoolId) focalPoolIds.add(centerPoolId);
  }
  // An edge focus pulls in the pools of BOTH its endpoints, so an edge that
  // spans two intents frames both of them — not just the source's. An
  // endpoint that is itself an Intent (e.g. a `serves` edge into an intent)
  // resolves to that intent's pool.
  if (focusedEdgeId) {
    for (const id of focusedNodeIds) {
      const poolId = nodeById.get(id)?.pool_id ?? pools.find((pool) => pool.intent_id === id)?.id;
      if (poolId) focalPoolIds.add(poolId);
    }
  }

  const renderedNodeIds = new Set<string>();
  if (focalPoolIds.size === 0) return { focalPoolIds, renderedNodeIds };
  for (const node of nodes) {
    if (focalPoolIds.has(node.pool_id)) renderedNodeIds.add(node.id);
  }
  // First-degree cross-intent neighbours fan out only for a single-intent
  // focus. A cross-intent edge already renders both intents in full, so
  // there is nothing more to pull in.
  if (centerId && focalPoolIds.size === 1) {
    for (const link of links) {
      if (!SEQUENCE_FLOW_EDGES.has(link.edge_type)) continue;
      const neighborId =
        link.source === centerId ? link.target : link.target === centerId ? link.source : null;
      if (!neighborId) continue;
      const neighbor = nodeById.get(neighborId);
      if (neighbor && !focalPoolIds.has(neighbor.pool_id)) renderedNodeIds.add(neighborId);
    }
  }
  return { focalPoolIds, renderedNodeIds };
}

export function layOutProcess(
  pools: ProcessPool[],
  lanes: ProcessLane[],
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

  // Within each lane, sequence depth remains the x column. Nodes that
  // share a lane and a depth stack top-to-bottom instead of stealing
  // extra horizontal columns; linear sequence chains still advance
  // rightward because their depths differ.
  const { orderedByLane, columnByNode, stackIndexByNode, laneColumnStacks, maxColumn } =
    packProcessLaneColumns(
      lanes.map((lane) => lane.id),
      poolNodes,
      depthByNode,
    );

  // Per-node sizes. Compute first so column step and lane height can
  // accommodate the widest / tallest node anywhere in the graph —
  // keeps vertical alignment of columns across lanes. Milestones use
  // their own fixed compact size and don't count toward the lane-sizing
  // max (they live in a shorter band of their own).
  // Sub-process candidacy is a stable, data-level property: an Action
  // that serves an Intent — beyond its own pool — which is itself a pool
  // here. It drives both the reserved bottom room (below) and the "+"
  // marker, so a node's size and glyph don't flicker as the render
  // window shifts. Only the dashed link is render-gated (in the
  // component), since it needs the target pool header actually mounted.
  const poolIntentIds = new Set<string>();
  for (const pool of pools) if (pool.intent_id) poolIntentIds.add(pool.intent_id);
  const subprocessTargetsByNode = new Map<string, string[]>();

  const sizeByNode = new Map<string, { width: number; height: number }>();
  let maxNodeWidth = NODE_WIDTH;
  let maxNodeHeight = NODE_HEIGHT;
  for (const node of nodes) {
    const size = sizeForNode(node);
    const subTargets = subprocessTargetIntents(node, poolIntentIds);
    if (subTargets.length > 0) {
      subprocessTargetsByNode.set(node.id, subTargets);
      // Grow the box so the "+" marker has its own strip at the bottom,
      // clear of the label. The component pads the label by the same
      // amount; stacking/lane-height math below already keys off size.
      size.height += SUBPROCESS_MARKER_ROOM;
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
  const stackHeightByLaneColumn = new Map<string, number>();
  const maxStackHeightByLane = new Map<string, number>();
  for (const [key, stack] of laneColumnStacks.entries()) {
    const stackHeight = stack.reduce((sum, node, index) => {
      const size = sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
      return sum + size.height + (index > 0 ? NODE_GAP_Y : 0);
    }, 0);
    const laneId = key.split("\u0000")[0] ?? "";
    stackHeightByLaneColumn.set(key, stackHeight);
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
          (highlightFocal && pool.intent_id === centerId) ||
          Boolean(pool.intent_id && focusedNodeIds.has(pool.intent_id)),
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
      intent_id: pool.intent_id,
      lifecycle: pool.lifecycle,
    });
  }

  // Emit node nodes nested in their lane.
  for (const lane of lanes) {
    const list = orderedByLane.get(lane.id) ?? [];
    const containerHeight = laneHeightById.get(lane.id) ?? baseLaneHeight;
    for (const node of list) {
      const column = columnByNode.get(node.id) ?? 0;
      const size = sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
      const stackKey = processLaneColumnKey(lane.id, column);
      const stack = laneColumnStacks.get(stackKey) ?? [node];
      const stackHeight = stackHeightByLaneColumn.get(stackKey) ?? size.height;
      const stackIndex = stackIndexByNode.get(node.id) ?? 0;
      // Center the node within its column slot so wider/narrower
      // nodes still line up by their middle on the same x axis.
      const slotX = LANE_LABEL_WIDTH + LANE_CONTENT_LEFT_GUTTER + column * columnStep;
      const x = slotX + (maxNodeWidth - size.width) / 2;
      let y = (containerHeight - stackHeight) / 2;
      for (let i = 0; i < Math.max(0, stackIndex); i++) {
        const prev = sizeByNode.get(stack[i].id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
        y += prev.height + NODE_GAP_Y;
      }
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
          isSubprocess: subprocessTargetsByNode.has(node.id),
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

  // Adjacent cross-intent nodes — the focal node's first-degree neighbours
  // that belong to other intents. They don't sit in the drawn swim lane;
  // they hug the pool above or below it, on whichever edge the focal node
  // sits closer to, so the hand-off arrow stays short. They are top-level
  // React Flow nodes (no lane parent) at absolute canvas coordinates.
  const adjacentNodes = nodes.filter((node) => !poolNodeIds.has(node.id));
  if (adjacentNodes.length > 0 && centerId) {
    const band = poolGeometry[0];
    const poolTopY = band ? band.y : 0;
    const poolBottomY = band ? band.y + band.height : 0;
    const poolMidline = (poolTopY + poolBottomY) / 2;
    const focalPos = nodePositions.get(centerId);
    const focalSize = sizeByNode.get(centerId) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
    const focalCenterX = focalPos
      ? LANE_LEFT_INSET + focalPos.x + focalSize.width / 2
      : LANE_LEFT_INSET + laneWidth / 2;
    const focalCenterY = focalPos ? focalPos.y + focalSize.height / 2 : poolMidline;
    // The neighbours all attach to the focal node, so they share its side:
    // above the pool when the focal node is in its top half, else below.
    const side: "above" | "below" = focalCenterY < poolMidline ? "above" : "below";
    const adjacentPositions = layoutAdjacentNodes(
      adjacentNodes.map((node) => ({
        id: node.id,
        ...(sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT }),
        side,
      })),
      {
        centerX: focalCenterX,
        poolTopY,
        poolBottomY,
        gap: ADJACENT_POOL_GAP,
        columnGap: NODE_GAP_X,
      },
    );
    for (const node of adjacentNodes) {
      const pos = adjacentPositions.get(node.id);
      if (!pos) continue;
      const size = sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
      // Store the canvas position in the same lane-relative-x frame the
      // in-lane nodes use (their x omits LANE_LEFT_INSET, the lane parent's
      // inset), so reference numbering and external-edge stubs offset both
      // kinds of node identically.
      nodePositions.set(node.id, { x: pos.x - LANE_LEFT_INSET, y: pos.y });
      flowNodes.push({
        id: node.id,
        type: nodeTypeForShape(node.shape),
        position: { x: pos.x, y: pos.y },
        data: {
          node,
          isCenter: (highlightFocal && node.id === centerId) || focusedNodeIds.has(node.id),
          isSubprocess: subprocessTargetsByNode.has(node.id),
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
      const label = link.label?.trim() || "";
      const edgeData: Record<string, unknown> = {};
      if (label) {
        const { labelBoxStyle, labelStyle } = processEdgeLabelStyles(stroke);
        edgeData.label = label;
        edgeData.labelOpacity = edgeOpacity;
        edgeData.labelZIndex = 1;
        edgeData.labelBoxStyle = labelBoxStyle;
        edgeData.labelStyle = labelStyle;
      }
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
        zIndex: isFocused ? 3 : 0,
        data: Object.keys(edgeData).length > 0 ? edgeData : undefined,
        selectable: false,
        focusable: false,
        interactionWidth: clickable ? 18 : 0,
        style: {
          stroke,
          strokeWidth: isFocused ? Math.max(baseStrokeWidth, 5) : baseStrokeWidth,
          opacity: isFocused ? 1 : edgeOpacity,
          cursor: clickable ? "pointer" : undefined,
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

  return { flowNodes, flowEdges, nodePositions, lanes: laneGeometry, poolGeometry };
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
  /** Action serves an Intent beyond its own pool — render the BPMN
   *  collapsed-subprocess "+" marker and the dashed drill-down handle. */
  isSubprocess?: boolean;
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
// badges, keyed on the Intent id so re-numbering on pan never re-renders
// the whole header band. Only real Intent pools (non-null intent_id) carry
// a number; the Unassigned pool gets none.
const ProcessPoolReferenceBadge = memo(function ProcessPoolReferenceBadge({
  intentId,
  label,
}: {
  intentId: string;
  label: string;
}) {
  const referenceNumber = useReferenceNumber(intentId);
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
 * Pool header band. Renders the Intent's prose as a banner across the
 * full canvas width above the pool's lanes. The Unassigned pool gets
 * a quieter neutral header so it doesn't compete visually with the
 * real Intent pools above it.
 */
export function ProcessPoolHeaderNode({ data }: { data: ProcessPoolHeaderData }) {
  const isUnassigned = data.pool.intent_id === null;
  const bg = isUnassigned ? "rgba(0, 0, 0, 0.05)" : "rgba(40, 70, 160, 0.08)";
  const borderColor = isUnassigned ? "var(--color-border)" : "rgba(40, 70, 160, 0.35)";
  const topBorderWidth = data.isCenter ? 4 : 2;
  const bottomBorderWidth = data.isCenter ? 2 : 1;
  // Zoomed out far enough that the band's label and pills are illegible:
  // drop them so the pool reads as a plain tinted band, matching how the
  // shape nodes inside it simplify. The subprocess-link Handle stays
  // mounted at every zoom (it anchors dashed drill-down edges).
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
        cursor: !isUnassigned && data.pool.intent_id ? "pointer" : undefined,
      }}
      // No hover tooltip once simplified — a bare band carries no label,
      // visible or on hover, just like the simplified shape nodes.
      title={simplified ? undefined : data.pool.label}
    >
      {data.pool.intent_id ? (
        // Landing point for dashed sub-process links — pinned near the
        // top-left of the header where the Intent label reads, so the
        // arrow lands "on the Intent" rather than mid-band.
        <Handle
          type="target"
          id={SUBPROCESS_TARGET_HANDLE}
          position={Position.Top}
          isConnectable={false}
          style={{ background: "transparent", border: "none", left: 24 }}
        />
      ) : null}
      {simplified ? null : (
        <>
          {data.pool.intent_id ? (
            <ProcessPoolReferenceBadge intentId={data.pool.intent_id} label={data.pool.label} />
          ) : null}
          {!isUnassigned && data.pool.intent_id ? (
            <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
              <TypeBadge entityType="intent" lifecycle={data.pool.lifecycle} anchor="inline" />
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

function ProcessRectangleNode({ data }: { data: ProcessNodeData }) {
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

// BPMN collapsed sub-process marker — a small bordered square with a
// centered "+" (OMG BPMN 2.0 §10.2.4: a collapsed sub-process is a task
// glyph with a "+" marker). It sits *inside* the box, centered on the
// bottom edge. The Action reserves SUBPROCESS_MARKER_ROOM of bottom
// padding (ProcessTaskNode) over a box the layout grew by the same amount,
// so the marker never overlaps the label. The dashed drill-down link
// leaves the node's bottom-center handle — just under the marker — on
// its way down to the sub-process pool.
function SubprocessMarker({ stroke, hideGlyph = false }: { stroke: string; hideGlyph?: boolean }) {
  return (
    <>
      {/* The bottom Handle anchors the dashed drill-down edge and must
          stay mounted at every zoom; only the visible "+" glyph — a tiny
          illegible box when zoomed out — is dropped under LOD. */}
      {hideGlyph ? null : (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: 14,
            left: "50%",
            transform: "translateX(-50%)",
            width: 16,
            height: 16,
            boxSizing: "border-box",
            background: "#fff",
            border: `1.5px solid ${stroke}`,
            borderRadius: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            lineHeight: 1,
            fontWeight: 700,
            color: stroke,
            zIndex: 2,
            // Asymmetric bottom padding lifts the "+" glyph ~2px within the
            // box (the box stays put); the "+" optically reads low when
            // centered, so this nudges it toward the visual middle.
            paddingBottom: 4,
          }}
        >
          +
        </div>
      )}
      <Handle
        type="source"
        id={SUBPROCESS_SOURCE_HANDLE}
        position={Position.Bottom}
        isConnectable={false}
        style={{ background: "transparent", border: "none" }}
      />
    </>
  );
}

// BPMN Task — rounded rectangle. Sits between the sharp Rectangle (a
// policy box) and the fully-pill Rounded (the State stadium); the radius
// matches the OMG BPMN 2.0 task glyph. When the Action drills into a
// sub-process it also wears the collapsed-subprocess "+" marker.
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
        // Reserve a bottom strip for the collapsed-subprocess "+" so the
        // centered label never sits under it. The layout grew the box by
        // the same amount; border-box keeps the padding inside that box
        // instead of adding height on top of it.
        paddingBottom: data.isSubprocess ? SUBPROCESS_MARKER_ROOM : undefined,
        boxSizing: data.isSubprocess ? "border-box" : undefined,
      }}
    >
      {simplified ? null : <ProcessBadgeRow data={data} />}
      {simplified ? null : <ShapeLabel node={data.node} />}
      {/* commonHandles first so the id-less right (source) handle is the
          node's first source handle: xyflow binds an edge with no
          sourceHandle to bounds[0], and sequence flow must keep exiting
          right. The "+" marker's bottom handle is addressed by id. */}
      {commonHandles()}
      {data.isSubprocess ? <SubprocessMarker stroke={stroke} hideGlyph={simplified} /> : null}
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
  // `data`, so it can shift on every pan frame without rebuilding nodes.
  // The sidebar reads numbering from the *published* references
  // (usePerspectiveReferences), which is the canonical source; this DOM
  // attribute was only a fallback for perspectives that don't publish.
  return {
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
    </>
  );
}
