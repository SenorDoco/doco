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

import { Handle, MarkerType, Position, type Edge as ReactFlowEdge } from "@xyflow/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { FadingPlaceholderEdge } from "~/components/fading-placeholder-edge";
import {
  LifecycleBadge,
  NodeBadgeRow,
  ReferenceNumberBadge,
  TypeBadge,
} from "~/components/node-badges";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { StandardControls } from "~/components/perspective-canvas-overlays";
import { StableLabeledBezierEdge } from "~/components/stable-labeled-edge";
import { linksWithFocusedPoolMembership } from "~/lib/bpmn-focused-pool-links";
import { bpmnLaneColumnKey, packBpmnLaneColumns } from "~/lib/bpmn-lane-packing";
import type { BpmnLane, BpmnNode, BpmnPool, BpmnShape } from "~/lib/bpmn-perspective.server";
import { referenceAnchorColumns, referenceEdges } from "~/lib/bpmn-references";
import { computeForwardSequenceDepths } from "~/lib/bpmn-sequence-depth";
import { subprocessTargetIntents } from "~/lib/bpmn-subprocess";
import {
  highestRankedNodeId,
  selectMeasuredPersonalizedNodeIds,
  summarizeExternalConnections,
} from "~/lib/focused-render-selection";
import {
  computeDepthFromCenter,
  focalEdgeWidth,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import type { GraphReferenceItem } from "~/lib/graph-references";
import { lifecycleColor } from "~/lib/node-colors";
import { usePerspectiveReferences } from "~/lib/perspective-references";
import { useBufferedRenderedIds } from "~/lib/use-buffered-rendered-ids";
import "@xyflow/react/dist/style.css";

// MUST stay in sync with the matching exports in
// `~/lib/bpmn-perspective.server`. Can't import the values here —
// `.server.ts` modules are stripped from the client bundle, so
// value-imports from them fail the build.
const MILESTONE_LANE_ID = "__milestones__";
const ARTIFACTS_LANE_ID = "__artifacts__";

interface BpmnPerspectiveProps {
  docoHandle?: string | null;
  /**
   * One pool per Intent in the Doco (plus an "Unassigned" pool for
   * nodes that don't cite an Intent). Pools are rendered in the
   * order given — the server emits them sorted by descending global
   * PageRank, with the Unassigned pool pinned to the bottom.
   */
  pools: BpmnPool[];
  /**
   * Flat list of lanes across all pools; each lane carries its
   * `pool_id` so the renderer can group them. Lane ids are composite
   * (`<pool_id>::<base>`) so the same Principal in two pools is two
   * distinct lanes.
   */
  lanes: BpmnLane[];
  nodes: BpmnNode[];
  links: OverviewGraphLink[];
  /**
   * Per-node global PageRank score on the doco's edge graph.
   * The server emits this for diagnostics and stable pool ordering.
   */
  globalPagerank?: Record<string, number>;
  onNodeClick?: (node: BpmnNode) => void;
  onPoolClick?: (pool: BpmnPool) => void;
  onLaneClick?: (lane: BpmnLane) => void;
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
// The artifacts band sits below the actor lanes and holds References,
// Evals, Ideas, and Rules — the BPMN data objects / annotations /
// business-rule tasks that sit *alongside* the flow rather than in a
// swim lane. Slightly taller than the milestone band so the documents
// inside don't crowd, but still shorter than an actor lane.
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
const BPMN_RENDER_NODE_BUDGET = 100;
const BPMN_RENDER_FIRST_DEGREE_MIN = 50;
const BPMN_RENDER_EDGE_BUDGET = 700;
const BPMN_PLACEHOLDER_STUB_BUDGET = 120;

/**
 * Per-node box sizing — the label's character count drives how big
 * the React Flow box needs to be to fit the text without truncation.
 *
 * Formula: text area ≈ N * char_w * line_h, padded by `pad`. For
 * circles we square the box so the inscribed circle stays round.
 * NODE_WIDTH x NODE_HEIGHT is the floor — short labels keep the
 * default size so existing layouts don't shift unexpectedly.
 */
function sizeForNode(node: BpmnNode): { width: number; height: number } {
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

export function BpmnPerspective({
  docoHandle,
  pools,
  lanes: lanesRaw,
  nodes: nodesRaw,
  links,
  globalPagerank,
  onNodeClick,
  onPoolClick,
  onLaneClick,
  onCenterChange,
  onPaneClick,
  visibleLifecycles,
  centerId,
  initialFocusId,
  focusedEdgeId,
  focusedNodeIds,
  onEdgeClick,
}: BpmnPerspectiveProps) {
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
  const updateViewport = useCallback((next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  }, []);

  // Drop nodes whose lifecycle is filtered out. Lanes are never
  // dropped once the server emits them, so a filtered-out Action
  // does not make its swim lane disappear. Links are still filtered
  // by the existing nodeSet check inside layOutBpmn.
  const { filteredNodes, filteredLanes } = useMemo(() => {
    if (!visibleLifecycles) return { filteredNodes: nodes, filteredLanes: lanes };
    const fn = nodes.filter((n) => visibleLifecycles.has(n.lifecycle ?? "asserted"));
    return { filteredNodes: fn, filteredLanes: lanes };
  }, [nodes, lanes, visibleLifecycles]);

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

  const pageRankMap = useMemo(
    () => new Map(Object.entries(globalPagerank ?? {})),
    [globalPagerank],
  );
  const nodeByFullId = useMemo(
    () => new Map(filteredNodes.map((node) => [node.id, node])),
    [filteredNodes],
  );
  const filteredNodeIds = useMemo(
    () => new Set(filteredNodes.map((node) => node.id)),
    [filteredNodes],
  );
  const focusCandidates = useMemo(
    () => [
      ...filteredNodes,
      ...pools.flatMap((pool) =>
        pool.intent_id ? [{ id: pool.intent_id, lifecycle: pool.lifecycle, created_at: null }] : [],
      ),
    ],
    [filteredNodes, pools],
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
  const selectionCenterId = useMemo(
    () => focusCenterId ?? highestRankedNodeId(focusCandidates, pageRankMap) ?? centerId ?? null,
    [focusCenterId, focusCandidates, pageRankMap, centerId],
  );
  useEffect(() => {
    if (!centerId || focusCenterId || !selectionCenterId || selectionCenterId === centerId) return;
    onCenterChange?.(selectionCenterId);
  }, [centerId, focusCenterId, selectionCenterId, onCenterChange]);
  const focusedNodeIdSet = useMemo(() => new Set(focusedNodeIds ?? []), [focusedNodeIds]);

  const selectionPoolId = useMemo(() => {
    const poolFromIntent = pools.find((pool) => pool.intent_id === selectionCenterId)?.id;
    return (
      poolFromIntent ?? (selectionCenterId ? nodeByFullId.get(selectionCenterId)?.pool_id : null)
    );
  }, [pools, selectionCenterId, nodeByFullId]);
  const targetRenderedNodeIds = useMemo(() => {
    const selectionLinks = linksWithFocusedPoolMembership(
      pools,
      filteredNodes,
      links,
      selectionCenterId,
    );
    return selectMeasuredPersonalizedNodeIds(
      filteredNodes,
      selectionLinks,
      selectionCenterId,
      pageRankMap,
      BPMN_RENDER_NODE_BUDGET,
      { docoHandle, perspective: "bpmn" },
      { minFirstDegree: BPMN_RENDER_FIRST_DEGREE_MIN },
    );
  }, [pools, filteredNodes, links, selectionCenterId, pageRankMap, docoHandle]);
  const { renderedIds: renderedNodeIds, opacityById: renderWindowOpacityById } =
    useBufferedRenderedIds(targetRenderedNodeIds, filteredNodeIds);
  const renderedNodes = useMemo(
    () => filteredNodes.filter((node) => renderedNodeIds.has(node.id)),
    [filteredNodes, renderedNodeIds],
  );
  const renderedLaneIds = useMemo(
    () => new Set(renderedNodes.map((node) => node.laneId)),
    [renderedNodes],
  );
  const renderedPoolIds = useMemo(() => {
    const ids = new Set(renderedNodes.map((node) => node.pool_id));
    if (selectionPoolId) ids.add(selectionPoolId);
    return ids;
  }, [renderedNodes, selectionPoolId]);
  const renderedLanes = useMemo(
    () => filteredLanes.filter((lane) => renderedLaneIds.has(lane.id)),
    [filteredLanes, renderedLaneIds],
  );
  const renderedPools = useMemo(
    () => pools.filter((pool) => renderedPoolIds.has(pool.id)),
    [pools, renderedPoolIds],
  );
  const layoutPoolIds = useMemo(() => {
    const ids = new Set(filteredLanes.map((lane) => lane.pool_id));
    if (selectionPoolId) ids.add(selectionPoolId);
    return ids;
  }, [filteredLanes, selectionPoolId]);
  const layoutPools = useMemo(
    () => pools.filter((pool) => layoutPoolIds.has(pool.id)),
    [pools, layoutPoolIds],
  );
  const layoutLinks = useMemo(
    () =>
      links.filter((link) => filteredNodeIds.has(link.source) && filteredNodeIds.has(link.target)),
    [links, filteredNodeIds],
  );
  // Solve BPMN geometry from the stable visible graph, not from the
  // transient 20-node render window. React Flow still mounts only the
  // buffered render window below, but coordinates for surviving nodes
  // remain anchored as focus changes.
  const layout = useMemo(
    () =>
      layOutBpmn(
        layoutPools,
        filteredLanes,
        filteredNodes,
        layoutLinks,
        focusCenterId,
        focusedNodeIdSet,
        focusedEdgeId ?? null,
      ),
    [
      layoutPools,
      filteredLanes,
      filteredNodes,
      layoutLinks,
      focusCenterId,
      focusedNodeIdSet,
      focusedEdgeId,
    ],
  );
  const nodeTypes = useMemo(
    () => ({
      bpmnLane: BpmnLaneNode,
      bpmnPoolHeader: BpmnPoolHeaderNode,
      bpmnCircle: BpmnCircleNode,
      bpmnDiamond: BpmnDiamondNode,
      bpmnRectangle: BpmnRectangleNode,
      bpmnDocument: BpmnDocumentNode,
      bpmnRounded: BpmnRoundedNode,
      bpmnTask: BpmnTaskNode,
      bpmnMilestone: BpmnMilestoneNode,
      bpmnEdgeStub: BpmnEdgeStubNode,
    }),
    [],
  );
  const edgeTypes = useMemo(
    () => ({
      fadingPlaceholder: FadingPlaceholderEdge,
      stableLabeledBezier: StableLabeledBezierEdge,
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
    (pool: BpmnPool) => {
      if (!pool.intent_id) return;
      if (onCenterChange) onCenterChange(pool.intent_id);
      onPoolClick?.(pool);
    },
    [onCenterChange, onPoolClick],
  );
  const openLaneNode = useCallback(
    (lane: BpmnLane) => {
      if (!isActorLane(lane) || !lane.base_id.startsWith("principal_")) return;
      if (onCenterChange) onCenterChange(lane.base_id);
      onLaneClick?.(lane);
    },
    [onCenterChange, onLaneClick],
  );

  // Principal-owned lanes are first-class references — they get
  // numbers 1..N (in lane order) before any shape, so a viewer can
  // jump from the sidebar straight to the swimlane owner. Passed to
  // the shared hook as `priorityItems`; the hook handles every shape
  // node's numbering (sort, viewport-cull, cap, registry publish).
  const laneReferences = useMemo<GraphReferenceItem[]>(
    () =>
      renderedLanes
        .filter((lane) => isActorLane(lane))
        .map((lane, index) => ({
          number: index + 1,
          id: lane.id,
          entity_type: "principal",
          label: lane.label,
          lifecycle: lane.lifecycle ?? "asserted",
          href: null,
        })),
    [renderedLanes],
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
            lifecycle: node.lifecycle ?? "asserted",
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
    source: "bpmn",
    viewport,
    size: graphSize,
    candidates: nodeReferenceCandidates,
    priorityItems: laneReferences,
  });

  const externalEdgeStubs = useMemo(() => {
    const summaries = summarizeExternalConnections(links, renderedNodeIds, filteredNodeIds);
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let stubIndex = 0;

    const addStub = (
      anchorNode: BpmnNode,
      direction: "incoming" | "outgoing",
      count: number,
      summaryIndex: number,
    ) => {
      if (stubIndex >= BPMN_PLACEHOLDER_STUB_BUDGET) return;
      const position = layout.nodePositions.get(anchorNode.id);
      if (!position) return;
      const size = sizeForNode(anchorNode);
      const id = `bpmn-placeholder:${direction}:${anchorNode.id}`;
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
        type: "bpmnEdgeStub",
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
        id: `bpmn-placeholder-edge:${direction}:${anchorNode.id}`,
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
  // are decided in layOutBpmn (stable, data-level, rides on the node's
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

  // Reference "see also" links. References now sit in the column of the
  // step they cite (see referenceAnchorColumns in layOutBpmn), so the
  // association edges tying them to that step render here as short gray
  // dashed lines — not sequence-flow arrows. Render-gated to on-canvas
  // pairs via renderedNodeIds, the same way the flow and subprocess edges
  // are, so a link never dangles.
  const referenceLinkEdges = useMemo<FlowEdge[]>(() => {
    const referenceNodeIds = new Set<string>();
    for (const [id, node] of nodeById) {
      if (node.entity_type === "reference") referenceNodeIds.add(id);
    }
    if (referenceNodeIds.size === 0) return [];
    return referenceEdges(links, referenceNodeIds, renderedNodeIds).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // "default" is xyflow's built-in bezier edge; it binds to the id-less
      // left/right handles every shape renders via commonHandles().
      type: "default",
      selectable: false,
      focusable: false,
      interactionWidth: 0,
      style: {
        stroke: REFERENCE_EDGE_COLOR,
        strokeWidth: 1.5,
        strokeDasharray: "6 4",
      },
    }));
  }, [links, nodeById, renderedNodeIds]);

  const flowNodes = useMemo<FlowNode[]>(() => {
    const windowed = layout.flowNodes.flatMap<FlowNode>((node) => {
      const laneData = (node.data as { lane?: BpmnLane; pool?: BpmnPool }).lane;
      const poolData = (node.data as { lane?: BpmnLane; pool?: BpmnPool }).pool;
      const isRendered =
        (laneData && renderedLaneIds.has(laneData.id)) ||
        (poolData && renderedPoolIds.has(poolData.id)) ||
        (!laneData && !poolData && renderedNodeIds.has(node.id));
      if (!isRendered) return [];
      // Lane FlowNodes carry data.lane; shape FlowNodes carry data.node.
      // Each pulls its reference number from the unified map by the
      // underlying entity id (principal_<ulid> or node id).
      if (laneData) {
        const referenceNumber = referenceNumberByEntityId.get(laneData.id);
        const data = {
          ...node.data,
          onLaneClick: isActorLane(laneData) ? openLaneNode : undefined,
        };
        if (!referenceNumber) return [{ ...node, data }];
        return [{ ...node, data: { ...data, referenceNumber } }];
      }
      const referenceNumber = referenceNumberByEntityId.get(node.id);
      const baseOpacity =
        typeof node.style?.opacity === "number" ? node.style.opacity : Number(node.style?.opacity);
      const transitionOpacity = renderWindowOpacityById.get(node.id) ?? 1;
      const style = {
        ...node.style,
        opacity: (Number.isFinite(baseOpacity) ? baseOpacity : 1) * transitionOpacity,
        transition: "opacity 500ms ease",
      };
      if (!referenceNumber || !nodeById.has(node.id)) return [{ ...node, style }];
      return [{ ...node, data: { ...node.data, referenceNumber }, style }];
    });
    return [...windowed, ...externalEdgeStubs.nodes];
  }, [
    layout.flowNodes,
    referenceNumberByEntityId,
    nodeById,
    renderedLaneIds,
    renderedPoolIds,
    renderedNodeIds,
    renderWindowOpacityById,
    openLaneNode,
    externalEdgeStubs.nodes,
  ]);
  const flowEdges = useMemo<FlowEdge[]>(
    () => [
      ...layout.flowEdges
        .filter((edge) => renderedNodeIds.has(edge.source) && renderedNodeIds.has(edge.target))
        .slice(0, BPMN_RENDER_EDGE_BUDGET)
        .map((edge) => {
          const transitionOpacity = Math.min(
            renderWindowOpacityById.get(edge.source) ?? 1,
            renderWindowOpacityById.get(edge.target) ?? 1,
          );
          const baseOpacity =
            typeof edge.style?.opacity === "number"
              ? edge.style.opacity
              : Number(edge.style?.opacity);
          const edgeData = edge.data as
            | (Record<string, unknown> & {
                labelBoxStyle?: CSSProperties;
                labelOpacity?: number;
              })
            | undefined;
          const labelOpacity =
            typeof edgeData?.labelOpacity === "number" ? edgeData.labelOpacity : 1;
          const data =
            edgeData && "labelOpacity" in edgeData
              ? {
                  ...edgeData,
                  labelOpacity: labelOpacity * transitionOpacity,
                  labelBoxStyle: {
                    ...edgeData.labelBoxStyle,
                    transition: "opacity 500ms ease",
                  },
                }
              : edgeData;
          return {
            ...edge,
            data,
            style: {
              ...edge.style,
              opacity: (Number.isFinite(baseOpacity) ? baseOpacity : 1) * transitionOpacity,
              transition: "opacity 500ms ease, stroke-opacity 500ms ease",
            },
          };
        }),
      ...externalEdgeStubs.edges,
      ...subprocessEdges,
      ...referenceLinkEdges,
    ],
    [
      layout.flowEdges,
      renderedNodeIds,
      renderWindowOpacityById,
      externalEdgeStubs.edges,
      subprocessEdges,
      referenceLinkEdges,
    ],
  );
  // Initial focus: an explicit URL focus wins; otherwise fall back to the
  // selection center (highest global PageRank in the BPMN view) so opening
  // the perspective centers on the most important node, matching the
  // overview graph's behavior.
  const initialFocusFlowNodeId = useMemo(() => {
    const target = initialFocusId ?? selectionCenterId;
    if (!target) return null;
    const flowNodeIds = new Set(flowNodes.map((node) => node.id));
    if (flowNodeIds.has(target)) return target;
    const pool = pools.find((candidate) => candidate.intent_id === target);
    if (pool) {
      const poolHeaderId = `pool-header:${pool.id}`;
      if (flowNodeIds.has(poolHeaderId)) return poolHeaderId;
    }
    const lane = renderedLanes.find((candidate) => candidate.base_id === target);
    if (lane) {
      const id = laneNodeId(lane.id);
      if (flowNodeIds.has(id)) return id;
    }
    return null;
  }, [flowNodes, initialFocusId, selectionCenterId, pools, renderedLanes]);

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
      instance.fitView?.({
        nodes: [{ id: initialFocusFlowNodeId }],
        padding: 0,
        minZoom: 1,
        maxZoom: 1,
        duration: 0,
      });
      const current = instance.getViewport?.();
      if (current) updateViewport(current);
      if (hasExplicitFocus) initialFocusAppliedRef.current = initialFocusFlowNodeId;
      else defaultFocusAppliedRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialFocusFlowNodeId, initialFocusId, updateViewport]);

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
  // label visually matches the in-canvas BpmnLaneNode label (which lives
  // inside React Flow's zoom transform). Font family/weight/case mirror
  // the in-canvas styling so the two reads as the same label.
  //
  // Suppress the rail when the in-canvas label is clearly visible past
  // the rail's right edge — otherwise the label reads twice. The
  // in-canvas label spans canvas x=LANE_LEFT_INSET..(LANE_LEFT_INSET +
  // LANE_LABEL_WIDTH); in screen coords that's viewport.x + lo*zoom
  // through viewport.x + hi*zoom. When the right edge is past the
  // rail's right edge the user can already read the lane name.
  const SWIM_RAIL_WIDTH = 32;
  const RAIL_LABEL_BASE_FONT = 11;
  const RAIL_BADGE_BASE_FONT = 10;
  const inCanvasLabelRightEdge = viewport.x + (LANE_LEFT_INSET + LANE_LABEL_WIDTH) * viewport.zoom;
  const showRailLabels = inCanvasLabelRightEdge <= SWIM_RAIL_WIDTH;
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
            data-bpmn-lane-rail={lane.id}
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
      {Flow ? (
        <Flow.ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          zIndexMode="manual"
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements
          minZoom={0.1}
          maxZoom={2.0}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
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
            // Change the focus window without refitting or rebuilding
            // geometry from that small window. The stable BPMN layout
            // above keeps already-rendered nodes anchored.
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
          <StandardControls />
        </Flow.ReactFlow>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
          Loading BPMN view…
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
      {Flow && stickyPools.length > 0 ? (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex flex-col">
          {stickyPools.map((pool) => {
            const isUnassigned = pool.intent_id === null;
            const sourcePool = poolById.get(pool.id);
            const isClickablePool = !isUnassigned && Boolean(sourcePool?.intent_id);
            // Mirror the in-canvas BpmnPoolHeaderNode look: same overlay
            // color over an opaque card so the sticky band reads as a
            // pinned copy of the natural header (not a different chrome
            // element). Font and padding scale with viewport.zoom —
            // like the swim-lane rails — so the sticky doesn't grow
            // visually huge when zoomed out.
            const overlay = isUnassigned ? "rgba(0, 0, 0, 0.05)" : "rgba(40, 70, 160, 0.08)";
            const borderColor = isUnassigned ? "var(--color-border)" : "rgba(40, 70, 160, 0.35)";
            const labelFontPx = 12 * viewport.zoom;
            const padX = 14 * viewport.zoom;
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
  animated?: boolean;
  markerEnd?: { type: MarkerType; width?: number; height?: number; color?: string };
}

interface BpmnLayout {
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
// Reference "see also" links: a node's edge to the source material it
// cites. Drawn as a gray dashed line — arrowless, because the relation is
// non-directional reference, not process flow.
const REFERENCE_EDGE_COLOR = "#9ca3af"; // gray-400
// Vertical room reserved at the bottom of a sub-process Action so the
// "+" marker sits inside the box without colliding with the label. The
// layout grows the node by this much; the node component pads its label
// area by the same amount so text never enters the marker strip.
const SUBPROCESS_MARKER_ROOM = 20;

function bpmnGraphRankNodes(
  pools: readonly BpmnPool[],
  nodes: readonly BpmnNode[],
): Array<{ id: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string }> = [];
  const add = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id });
  };
  for (const node of nodes) add(node.id);
  for (const pool of pools) add(pool.intent_id);
  return out;
}

function layOutBpmn(
  pools: BpmnPool[],
  lanes: BpmnLane[],
  nodes: BpmnNode[],
  links: OverviewGraphLink[],
  centerId: string | null | undefined,
  focusedNodeIds: ReadonlySet<string>,
  focusedEdgeId: string | null,
): BpmnLayout {
  // Per-node BFS depth from the focal node — used to fade non-
  // neighbours. Separate from `computeDepths` below, which is the
  // topological column position used for left-to-right layout.
  const focusNodes = bpmnGraphRankNodes(pools, nodes);
  const focusLinks = linksWithFocusedPoolMembership(pools, nodes, links, centerId);
  const focalDepthByNode = computeDepthFromCenter(focusNodes, focusLinks, centerId);
  const focalActive = hasFocalNode(centerId, focusNodes);

  const byLane = new Map<string, BpmnNode[]>();
  for (const lane of lanes) byLane.set(lane.id, []);
  for (const node of nodes) {
    const list = byLane.get(node.laneId);
    if (list) list.push(node);
  }

  // Compute one global column per node so that sequence-flow targets
  // sit to the right of their ordinary incoming source across lanes.
  // Intentional feedback loops are treated as loopbacks instead of
  // being allowed to pull earlier nodes backward.
  const depthByNode = computeForwardSequenceDepths(nodes, links);

  // References carry no sequence flow, so by depth alone they'd all pile
  // into column 0 (far left of the artifacts band). Instead place each
  // reference in the column of the step it cites, so it sits directly under
  // that node and its dashed "see also" link stays short. Only the column
  // input to packing changes; sequence depth itself is untouched.
  const columnDepthByNode = new Map(depthByNode);
  for (const [refId, column] of referenceAnchorColumns(nodes, links, depthByNode)) {
    columnDepthByNode.set(refId, column);
  }

  // Within each lane, sequence depth remains the x column. Nodes that
  // share a lane and a depth stack top-to-bottom instead of stealing
  // extra horizontal columns; linear sequence chains still advance
  // rightward because their depths differ.
  const { orderedByLane, columnByNode, stackIndexByNode, laneColumnStacks, maxColumn } =
    packBpmnLaneColumns(
      lanes.map((lane) => lane.id),
      nodes,
      columnDepthByNode,
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
    if (size.width > maxNodeWidth) maxNodeWidth = size.width;
    if (size.height > maxNodeHeight) maxNodeHeight = size.height;
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
  const poolGeometry: BpmnLayout["poolGeometry"] = [];

  // Group lanes by pool so each pool can emit its header + its own
  // lanes in display order, then accumulate height.
  const lanesByPool = new Map<string, BpmnLane[]>();
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
      type: "bpmnPoolHeader",
      position: { x: LANE_LEFT_INSET, y: cursorY },
      data: {
        pool,
        width: laneWidth,
        height: POOL_HEADER_HEIGHT,
        isCenter:
          pool.intent_id === centerId ||
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
        type: "bpmnLane",
        position: { x: LANE_LEFT_INSET, y: cursorY },
        data: {
          lane,
          height: laneHeight,
          width: laneWidth,
          labelWidth: LANE_LABEL_WIDTH,
          isMilestoneBand: lane.kind === "milestone",
          isArtifactsBand: lane.kind === "artifacts",
          isCenter:
            isActorLane(lane) && (lane.base_id === centerId || focusedNodeIds.has(lane.base_id)),
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
      const stackKey = bpmnLaneColumnKey(lane.id, column);
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
      const nodeOpacity = focalActive ? opacityForDepth(focalDepthByNode.get(node.id)) : 1;
      flowNodes.push({
        id: node.id,
        type: nodeTypeForShape(node.shape),
        position: { x, y },
        parentId: laneNodeId(node.laneId),
        extent: "parent",
        data: {
          node,
          isCenter: node.id === centerId || focusedNodeIds.has(node.id),
          isSubprocess: subprocessTargetsByNode.has(node.id),
        },
        draggable: false,
        selectable: false,
        connectable: false,
        initialWidth: size.width,
        initialHeight: size.height,
        style: { width: size.width, height: size.height, zIndex: 1, opacity: nodeOpacity },
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
        edgeData.label = label;
        edgeData.labelOpacity = edgeOpacity;
        edgeData.labelZIndex = 1;
        edgeData.labelBoxStyle = {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${stroke}`,
          borderRadius: 4,
          background: "#ffffff",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.12)",
          padding: "2px 6px",
        };
        edgeData.labelStyle = {
          color: "#202020",
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1,
          whiteSpace: "nowrap",
        };
      }
      const bow = computeEdgeBow(source, target);
      if (bow) {
        edgeData.bowDir = bow.dir;
        edgeData.bowLift = bow.lift;
      }
      if (link.id) edgeData.graphLink = link;
      const isFocused = Boolean(focusedEdgeId && link.id === focusedEdgeId);
      const clickable = Boolean(link.id && link.href);
      const baseStrokeWidth = focalEdgeWidth(source, target, centerId, 1.75);
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

  const laneGeometry: BpmnLayout["lanes"] = lanes.map((lane) => {
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

function nodeTypeForShape(shape: BpmnShape): string {
  switch (shape) {
    case "circle":
      return "bpmnCircle";
    case "diamond":
      return "bpmnDiamond";
    case "document":
      return "bpmnDocument";
    case "rounded":
      return "bpmnRounded";
    case "task":
      return "bpmnTask";
    case "milestone":
      return "bpmnMilestone";
    default:
      return "bpmnRectangle";
  }
}

function laneNodeId(laneId: string): string {
  return `lane:${laneId}`;
}

// Used by the outer container sizing — keeps the band-height knowledge
// in one place rather than scattering ternaries through the layout.
function heightForLane(lane: BpmnLane): number {
  if (lane.kind === "milestone") return MILESTONE_BAND_HEIGHT;
  if (lane.kind === "artifacts") return ARTIFACTS_BAND_HEIGHT;
  return LANE_HEIGHT;
}

// Lanes that map to a real Principal carry `kind: "actor"` (their
// base id is `principal_<ulid>`). Reference numbering and "keep on
// filter" treat actor lanes differently from synthetic bands /
// catchall lanes.
function isActorLane(lane: BpmnLane): boolean {
  return lane.kind === "actor";
}

// ─── Custom node components ────────────────────────────────────────

interface BpmnNodeData {
  node: BpmnNode;
  referenceNumber?: number;
  isCenter?: boolean;
  /** Action serves an Intent beyond its own pool — render the BPMN
   *  collapsed-subprocess "+" marker and the dashed drill-down handle. */
  isSubprocess?: boolean;
}

interface BpmnLaneData {
  lane: BpmnLane;
  height: number;
  width: number;
  labelWidth: number;
  referenceNumber?: number;
  isCenter?: boolean;
  isMilestoneBand?: boolean;
  isArtifactsBand?: boolean;
  onLaneClick?: (lane: BpmnLane) => void;
}

interface BpmnPoolHeaderData {
  pool: BpmnPool;
  width: number;
  height: number;
  isCenter?: boolean;
}

function BpmnEdgeStubNode() {
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

/**
 * Pool header band. Renders the Intent's prose as a banner across the
 * full canvas width above the pool's lanes. The Unassigned pool gets
 * a quieter neutral header so it doesn't compete visually with the
 * real Intent pools above it.
 */
function BpmnPoolHeaderNode({ data }: { data: BpmnPoolHeaderData }) {
  const isUnassigned = data.pool.intent_id === null;
  const bg = isUnassigned ? "rgba(0, 0, 0, 0.05)" : "rgba(40, 70, 160, 0.08)";
  const borderColor = isUnassigned ? "var(--color-border)" : "rgba(40, 70, 160, 0.35)";
  const topBorderWidth = data.isCenter ? 4 : 2;
  const bottomBorderWidth = data.isCenter ? 2 : 1;
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
      title={data.pool.label}
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
    </div>
  );
}

function BpmnLaneNode({ data }: { data: BpmnLaneData }) {
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
        {data.referenceNumber ? (
          <span
            aria-label={`Graph reference #${data.referenceNumber}: ${data.lane.label}`}
            className="pointer-events-none absolute -left-2.5 top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
            title={`Graph reference #${data.referenceNumber}`}
          >
            #{data.referenceNumber}
          </span>
        ) : null}
        <span>{data.lane.label}</span>
        <LaneBadgeRow lane={data.lane} />
      </div>
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
function LaneBadgeRow({ lane }: { lane: BpmnLane }) {
  if (lane.kind !== "actor") return null;
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <TypeBadge entityType="principal" lifecycle={lane.lifecycle} anchor="inline" />
      <LifecycleBadge lifecycle={lane.lifecycle} anchor="inline" />
    </span>
  );
}

function ShapeLabel({ node }: { node: BpmnNode }) {
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
      <span className="line-clamp-3">{node.name ?? <em>(unnamed)</em>}</span>
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

function bpmnStrokeWidth(data: BpmnNodeData, baseWidth = 2): number {
  return data.isCenter ? baseWidth * 2 : baseWidth;
}

function bpmnBorder(data: BpmnNodeData, stroke: string, baseWidth = 2): string {
  return `${bpmnStrokeWidth(data, baseWidth)}px solid ${stroke}`;
}

function BpmnRectangleNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: bpmnBorder(data, stroke),
        borderRadius: 4,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <BpmnBadgeRow data={data} />
      <ShapeLabel node={data.node} />
      {commonHandles()}
    </div>
  );
}

function BpmnRoundedNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: bpmnBorder(data, stroke),
        borderRadius: 28,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <BpmnBadgeRow data={data} />
      <ShapeLabel node={data.node} />
      {commonHandles()}
    </div>
  );
}

// BPMN collapsed sub-process marker — a small bordered square with a
// centered "+" (OMG BPMN 2.0 §10.2.4: a collapsed sub-process is a task
// glyph with a "+" marker). It sits *inside* the box, centered on the
// bottom edge. The Action reserves SUBPROCESS_MARKER_ROOM of bottom
// padding (BpmnTaskNode) over a box the layout grew by the same amount,
// so the marker never overlaps the label. The dashed drill-down link
// leaves the node's bottom-center handle — just under the marker — on
// its way down to the sub-process pool.
function SubprocessMarker({ stroke }: { stroke: string }) {
  return (
    <>
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
// policy box) and the fully-pill Rounded (an Idea capsule); the radius
// matches the OMG BPMN 2.0 task glyph. When the Action drills into a
// sub-process it also wears the collapsed-subprocess "+" marker.
function BpmnTaskNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: bpmnBorder(data, stroke),
        borderRadius: 12,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        // Reserve a bottom strip for the collapsed-subprocess "+" so the
        // centered label never sits under it. The layout grew the box by
        // the same amount; border-box keeps the padding inside that box
        // instead of adding height on top of it.
        paddingBottom: data.isSubprocess ? SUBPROCESS_MARKER_ROOM : undefined,
        boxSizing: data.isSubprocess ? "border-box" : undefined,
      }}
    >
      <BpmnBadgeRow data={data} />
      <ShapeLabel node={data.node} />
      {/* commonHandles first so the id-less right (source) handle is the
          node's first source handle: xyflow binds an edge with no
          sourceHandle to bounds[0], and sequence flow must keep exiting
          right. The "+" marker's bottom handle is addressed by id. */}
      {commonHandles()}
      {data.isSubprocess ? <SubprocessMarker stroke={stroke} /> : null}
    </div>
  );
}

// Milestone — compact labeled box. Lives in the milestone band above
// the swim lanes; the band's tinted background does most of the visual
// work, so the node itself is intentionally subdued (thin border,
// uppercase compact label) so a row of milestones reads as a phase
// timeline rather than a row of flow shapes.
function BpmnMilestoneNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: bpmnBorder(data, stroke, 1),
        borderRadius: 4,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 8px",
        boxSizing: "border-box",
      }}
    >
      <BpmnBadgeRow data={data} />
      <span
        className="pointer-events-none line-clamp-2 text-center text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: "#1f1f1f", letterSpacing: 0.4 }}
        title={data.node.name ?? ""}
      >
        {data.node.name ?? <em>(unnamed)</em>}
      </span>
      {commonHandles()}
    </div>
  );
}

function BpmnCircleNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
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
      <BpmnBadgeRow data={data} circular />
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#fff",
          border: bpmnBorder(data, stroke),
          borderRadius: "50%",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        <ShapeLabel node={data.node} />
      </div>
      {commonHandles()}
    </div>
  );
}

function BpmnDiamondNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
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
      <BpmnBadgeRow data={data} />
      <svg
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.04))",
          pointerEvents: "none",
        }}
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        <polygon
          points="50,2 98,50 50,98 2,50"
          fill="#fff"
          stroke={stroke}
          strokeWidth={bpmnStrokeWidth(data)}
        />
      </svg>
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
      {commonHandles()}
    </div>
  );
}

function BpmnDocumentNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
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
      <BpmnBadgeRow data={data} />
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
          strokeWidth={bpmnStrokeWidth(data)}
        />
      </svg>
      <ShapeLabel node={data.node} />
      {commonHandles()}
    </div>
  );
}

function graphReferenceAttributes(data: BpmnNodeData): Record<string, string | number | undefined> {
  return {
    "data-graph-reference-number": data.referenceNumber,
    "data-node-href": data.node.href ?? undefined,
    "data-node-id": data.node.id,
    "data-node-label": data.node.name ?? data.node.id,
    "data-node-lifecycle": data.node.lifecycle ?? "asserted",
    "data-node-type": data.node.entity_type,
  };
}

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
function BpmnBadgeRow({ data }: { data: BpmnNodeData; circular?: boolean }) {
  return (
    <>
      <NodeBadgeRow
        entityType={data.node.entity_type}
        lifecycle={data.node.lifecycle}
        className="nodrag nopan"
        interactive
      />
      <ReferenceNumberBadge
        referenceNumber={data.referenceNumber}
        referenceLabel={data.node.name ?? data.node.id}
      />
    </>
  );
}
