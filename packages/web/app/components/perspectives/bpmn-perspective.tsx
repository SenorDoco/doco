// BPMN perspective — swim lanes, BPMN-inspired shapes, lifecycle
// coloring. Owned by torrenegra per the seeded perspectives row.
//
// Layout strategy:
//   • One horizontal lane per principal (plus process bands).
//   • Lanes are React Flow parent nodes; neurons set parentId to nest
//     visually inside their lane.
//   • Within each lane, neurons are placed in a topological sweep over
//     explicit `sequence_flow` edges. Stored source -> target direction
//     is rendered directly; association synapses do not become arrows.
//   • Lifecycle color renders as the shape's stroke; the type icon
//     identifies the neuron type at a glance.
//
// Shape rendering uses custom React Flow node types — one component
// per shape (circle, diamond, rectangle, document, rounded). Handles
// sit on left/right edges so synapses connect cleanly regardless of
// lane vertical offset.

import { Handle, MarkerType, Position } from "@xyflow/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { FullLayoutMiniMap } from "~/components/full-layout-minimap";
import {
  LifecycleBadge,
  NodeBadgeRow,
  ReferenceNumberBadge,
  TypeBadge,
} from "~/components/neuron-badges";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { StandardControls } from "~/components/perspective-canvas-overlays";
import { bpmnLaneColumnKey, packBpmnLaneColumns } from "~/lib/bpmn-lane-packing";
import type { BpmnLane, BpmnNode, BpmnPool, BpmnShape } from "~/lib/bpmn-perspective.server";
import { computeForwardSequenceDepths } from "~/lib/bpmn-sequence-depth";
import type { FullLayoutMiniMapItem, FullLayoutMiniMapShape } from "~/lib/full-layout-minimap";
import {
  computeDepthFromCenter,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import type { GraphReferenceItem } from "~/lib/graph-references";
import { lifecycleColor } from "~/lib/neuron-colors";
import { usePerspectiveReferences } from "~/lib/perspective-references";
import { rectForCandidate, rectsIntersect, selectRenderWindow } from "~/lib/viewport-render-window";
import "@xyflow/react/dist/style.css";

// MUST stay in sync with the matching exports in
// `~/lib/bpmn-perspective.server`. Can't import the values here —
// `.server.ts` modules are stripped from the client bundle, so
// value-imports from them fail the build.
const MILESTONE_LANE_ID = "__milestones__";
const ARTIFACTS_LANE_ID = "__artifacts__";

interface BpmnPerspectiveProps {
  /**
   * One pool per Intent in the Doco (plus an "Unassigned" pool for
   * neurons that don't cite an Intent). Pools are rendered in the
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
   * Per-neuron global PageRank score on the doco's synapse graph.
   * The server emits this for diagnostics and stable pool ordering.
   */
  globalPagerank?: Record<string, number>;
  onNeuronClick?: (node: BpmnNode) => void;
  onPoolClick?: (pool: BpmnPool) => void;
  onLaneClick?: (lane: BpmnLane) => void;
  /**
   * Lift focal-node state to the parent. Clicking a neuron on the
   * canvas should re-center the graph on it so depth-based opacity
   * recomputes from the new focal node; the parent owns the centerId
   * state and this callback is how the canvas asks it to update.
   * Same contract as OverviewGraph.onCenterChange.
   */
  onCenterChange?: (id: string) => void;
  /**
   * Page-level lifecycle filter set. Nodes whose lifecycle isn't in
   * this set are excluded; lanes that end up empty after filtering
   * are dropped from the lane list. When omitted, every node is
   * shown.
   */
  visibleLifecycles?: Set<string>;
  /**
   * When set, the BPMN canvas fades non-neighbours of this neuron
   * based on BFS depth (1st-degree solid, 2nd 75%, 3rd 50%, 4+ 25%).
   * Edges fade with their deepest endpoint. When null/undefined,
   * every node and edge renders at full opacity.
   */
  centerId?: string | null;
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
// Keep the first neuron visually separated from the swim-lane label
// divider. Without this, column-zero nodes can sit flush against the
// label boundary when they are the widest shape in the graph.
const LANE_CONTENT_LEFT_GUTTER = 32;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 60;
const NODE_GAP_Y = 40; // padding above/below stacked rows inside the lane
const BPMN_RENDER_NODE_BUDGET = 700;
const BPMN_RENDER_EDGE_BUDGET = 1200;
const BPMN_RENDER_OVERSCAN_PX = 700;

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
  pools,
  lanes: lanesRaw,
  nodes: nodesRaw,
  links,
  onNeuronClick,
  onPoolClick,
  onLaneClick,
  onCenterChange,
  visibleLifecycles,
  centerId,
}: BpmnPerspectiveProps) {
  const lanes = lanesRaw;
  const nodes = nodesRaw;
  const navigate = useNavigate();
  const graphRef = useRef<HTMLDivElement>(null);
  const [Flow, setFlow] = useState<FlowModule | null>(null);
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const [graphSize, setGraphSize] = useState<GraphSize>({ width: 1, height: 1 });
  const hasFitRef = useRef(false);
  type FlowSetViewport = (viewport: FlowViewport, options?: { duration?: number }) => void;
  const flowRef = useRef<{ setViewport?: FlowSetViewport } | null>(null);
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
    const fn = nodes.filter((n) => visibleLifecycles.has(n.lifecycle ?? "active"));
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

  const layout = useMemo(
    () => layOutBpmn(pools, filteredLanes, filteredNodes, links, centerId),
    [pools, filteredLanes, filteredNodes, links, centerId],
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
    }),
    [],
  );
  const nodeById = useMemo(() => new Map(filteredNodes.map((n) => [n.id, n])), [filteredNodes]);
  const laneById = useMemo(
    () => new Map(filteredLanes.map((lane) => [lane.id, lane])),
    [filteredLanes],
  );
  const poolById = useMemo(() => new Map(pools.map((pool) => [pool.id, pool])), [pools]);
  const poolByHeaderId = useMemo(
    () => new Map(pools.map((pool) => [`pool-header:${pool.id}`, pool])),
    [pools],
  );
  const minimapItems = useMemo<FullLayoutMiniMapItem[]>(() => {
    const items: FullLayoutMiniMapItem[] = [];
    for (const node of layout.flowNodes) {
      const nodeData = (node.data as { node?: BpmnNode }).node;
      const nodePosition = layout.nodePositions.get(node.id);
      const rect = flowNodeRect(
        node,
        nodeData && nodePosition
          ? { x: LANE_LEFT_INSET + nodePosition.x, y: nodePosition.y }
          : nodePosition,
      );
      if (nodeData) {
        items.push({
          id: node.id,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          color: lifecycleColor(nodeData.lifecycle),
          kind: "node",
          shape: miniMapShapeForBpmn(nodeData.shape),
          opacity: typeof node.style?.opacity === "number" ? node.style.opacity : 1,
        });
        continue;
      }
      const laneData = (node.data as { lane?: BpmnLane }).lane;
      if (laneData) {
        items.push({
          id: node.id,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          color: laneData.kind === "milestone" ? "rgba(40, 70, 160, 0.14)" : "rgba(0, 0, 0, 0.05)",
          kind: "lane",
          shape: "rect",
          opacity: 1,
        });
        continue;
      }
      const poolData = (node.data as { pool?: BpmnPool }).pool;
      if (poolData) {
        items.push({
          id: node.id,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          color: poolData.intent_id ? "rgba(40, 70, 160, 0.18)" : "rgba(0, 0, 0, 0.06)",
          kind: "pool",
          shape: "rect",
          opacity: 1,
        });
      }
    }
    return items;
  }, [layout.flowNodes, layout.nodePositions]);
  const renderWindow = useMemo(
    () =>
      selectRenderWindow(
        filteredNodes.flatMap((node) => {
          const position = layout.nodePositions.get(node.id);
          if (!position) return [];
          const size = sizeForNode(node);
          return [
            {
              id: node.id,
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height,
              priority:
                node.id === centerId
                  ? 0
                  : bpmnWindowLifecycleRank(node.lifecycle) +
                    (node.entity_type === "action" ? 4 : 8),
            },
          ];
        }),
        {
          viewport,
          size: graphSize,
          maxItems: BPMN_RENDER_NODE_BUDGET,
          overscanPx: BPMN_RENDER_OVERSCAN_PX,
          mustIncludeIds: [centerId],
        },
      ),
    [filteredNodes, layout.nodePositions, centerId, viewport, graphSize],
  );
  const renderedNodeIds = renderWindow.ids;
  const renderedNodes = useMemo(
    () => filteredNodes.filter((node) => renderedNodeIds.has(node.id)),
    [filteredNodes, renderedNodeIds],
  );
  const openPoolNeuron = useCallback(
    (pool: BpmnPool) => {
      if (!pool.intent_id) return;
      if (onCenterChange) onCenterChange(pool.intent_id);
      onPoolClick?.(pool);
    },
    [onCenterChange, onPoolClick],
  );
  const openLaneNeuron = useCallback(
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
      filteredLanes
        .filter((lane) => isActorLane(lane))
        .map((lane, index) => ({
          number: index + 1,
          id: lane.id,
          entity_type: "principal",
          label: lane.label,
          lifecycle: lane.lifecycle ?? "active",
          href: null,
        })),
    [filteredLanes],
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
    source: "bpmn",
    viewport,
    size: graphSize,
    candidates: nodeReferenceCandidates,
    priorityItems: laneReferences,
  });

  const flowNodes = useMemo(() => {
    const requiredLaneNodeIds = new Set(renderedNodes.map((node) => laneNodeId(node.laneId)));
    const windowed = layout.flowNodes
      .filter((node) => {
        const nodeData = (node.data as { node?: BpmnNode }).node;
        if (nodeData) return renderedNodeIds.has(nodeData.id);
        if (requiredLaneNodeIds.has(node.id)) return true;
        const rect = rectForCandidate(flowNodeRect(node));
        return rectsIntersect(rect, renderWindow.overscanRect);
      })
      .map((node) => {
        // Lane FlowNodes carry data.lane; shape FlowNodes carry data.node.
        // Each pulls its reference number from the unified map by the
        // underlying entity id (principal_<ulid> or neuron id).
        const laneData = (node.data as { lane?: BpmnLane }).lane;
        if (laneData) {
          const referenceNumber = referenceNumberByEntityId.get(laneData.id);
          const data = {
            ...node.data,
            onLaneClick: isActorLane(laneData) ? openLaneNeuron : undefined,
          };
          if (!referenceNumber) return { ...node, data };
          return { ...node, data: { ...data, referenceNumber } };
        }
        const referenceNumber = referenceNumberByEntityId.get(node.id);
        if (!referenceNumber || !nodeById.has(node.id)) return node;
        return { ...node, data: { ...node.data, referenceNumber } };
      });
    return windowed;
  }, [
    layout.flowNodes,
    renderedNodes,
    renderedNodeIds,
    renderWindow.overscanRect,
    referenceNumberByEntityId,
    nodeById,
    openLaneNeuron,
  ]);
  const flowEdges = useMemo(
    () =>
      layout.flowEdges
        .filter((edge) => renderedNodeIds.has(edge.source) && renderedNodeIds.has(edge.target))
        .slice(0, BPMN_RENDER_EDGE_BUDGET),
    [layout.flowEdges, renderedNodeIds],
  );
  const panToMiniMapPoint = useCallback(
    (point: { x: number; y: number }) => {
      const zoom = viewport.zoom;
      const next = {
        x: graphSize.width / 2 - point.x * zoom,
        y: graphSize.height / 2 - point.y * zoom,
        zoom,
      };
      flowRef.current?.setViewport?.(next, { duration: 120 });
      updateViewport(next);
    },
    [graphSize.height, graphSize.width, updateViewport, viewport.zoom],
  );

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
            onClick={isClickableLane && sourceLane ? () => openLaneNeuron(sourceLane) : undefined}
            onKeyDown={
              isClickableLane && sourceLane
                ? (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openLaneNeuron(sourceLane);
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
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements
          fitView
          minZoom={0.1}
          maxZoom={2.0}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          preventScrolling
          onInit={(instance: {
            fitView?: (options?: { padding?: number }) => void;
            setViewport?: FlowSetViewport;
            getViewport?: () => FlowViewport;
          }) => {
            flowRef.current = instance;
            if (!hasFitRef.current) {
              instance.fitView?.({ padding: 0.18 });
              hasFitRef.current = true;
            }
            const current = instance.getViewport?.();
            if (current) updateViewport(current);
          }}
          onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
          onNodeClick={(_e: unknown, node: { id: string }) => {
            const pool = poolByHeaderId.get(node.id);
            if (pool) {
              openPoolNeuron(pool);
              return;
            }
            const target = nodeById.get(node.id);
            if (!target) return;
            // Re-center first so depth opacity recomputes from the
            // clicked node before the dialog opens / the route changes.
            if (onCenterChange) onCenterChange(target.id);
            if (onNeuronClick) {
              onNeuronClick(target);
              return;
            }
            if (target.href) navigate(target.href);
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
        <FullLayoutMiniMap
          items={minimapItems}
          viewport={viewport}
          size={graphSize}
          onPanTo={panToMiniMapPoint}
        />
      ) : null}
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
                onClick={
                  isClickablePool && sourcePool ? () => openPoolNeuron(sourcePool) : undefined
                }
                onKeyDown={
                  isClickablePool && sourcePool
                    ? (event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        openPoolNeuron(sourcePool);
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
  type: string;
  selectable: boolean;
  focusable: boolean;
  interactionWidth: number;
  style?: CSSProperties;
  animated?: boolean;
  markerEnd?: { type: MarkerType; width?: number; height?: number; color?: string };
}

function bpmnWindowLifecycleRank(lifecycle: string | null | undefined): number {
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

function flowNodeRect(
  node: FlowNode,
  absolutePosition?: { x: number; y: number },
): { id: string; x: number; y: number; width: number; height: number } {
  return {
    id: node.id,
    x: absolutePosition?.x ?? node.position.x,
    y: absolutePosition?.y ?? node.position.y,
    width:
      typeof node.style?.width === "number" ? node.style.width : (node.initialWidth ?? NODE_WIDTH),
    height:
      typeof node.style?.height === "number"
        ? node.style.height
        : (node.initialHeight ?? NODE_HEIGHT),
  };
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
): BpmnLayout {
  // Per-node BFS depth from the focal neuron — used to fade non-
  // neighbours. Separate from `computeDepths` below, which is the
  // topological column position used for left-to-right layout.
  const focusNodes = bpmnGraphRankNodes(pools, nodes);
  const focalDepthByNode = computeDepthFromCenter(focusNodes, links, centerId);
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

  // Within each lane, sequence depth remains the x column. Nodes that
  // share a lane and a depth stack top-to-bottom instead of stealing
  // extra horizontal columns; linear sequence chains still advance
  // rightward because their depths differ.
  const { orderedByLane, columnByNode, stackIndexByNode, laneColumnStacks, maxColumn } =
    packBpmnLaneColumns(
      lanes.map((lane) => lane.id),
      nodes,
      depthByNode,
    );

  // Per-node sizes. Compute first so column step and lane height can
  // accommodate the widest / tallest node anywhere in the graph —
  // keeps vertical alignment of columns across lanes. Milestones use
  // their own fixed compact size and don't count toward the lane-sizing
  // max (they live in a shorter band of their own).
  const sizeByNode = new Map<string, { width: number; height: number }>();
  let maxNodeWidth = NODE_WIDTH;
  let maxNodeHeight = NODE_HEIGHT;
  for (const node of nodes) {
    const size = sizeForNode(node);
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

  // Emit neuron nodes nested in their lane.
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
        data: { node },
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
  const flowEdges: FlowEdge[] = links
    .filter((link) => nodeSet.has(link.source) && nodeSet.has(link.target))
    .filter((link) => SEQUENCE_FLOW_SYNAPSES.has(link.synapse_type))
    .map((link, index) => {
      const source = link.source;
      const target = link.target;
      const edgeOpacity = focalActive
        ? opacityForEdge(focalDepthByNode.get(source), focalDepthByNode.get(target))
        : 1;
      // Synapse inherits the origin neuron's lifecycle color so an
      // arrow visually "carries" the state of its source — drafted
      // work flows in yellow, active work in black, retired in red.
      const stroke = lifecycleColor(nodeById.get(link.source)?.lifecycle);
      return {
        id: `${link.source}-${link.target}-${index}`,
        source,
        target,
        // Bezier curves keep process arrows compact and visually soft.
        // They may pass behind intervening neurons in dense diagrams,
        // but they read better than the heavier lane-gutter router.
        type: "bezier",
        selectable: false,
        focusable: false,
        interactionWidth: 0,
        style: {
          stroke,
          strokeWidth: 1.75,
          opacity: edgeOpacity,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
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
 * Synapse types that express BPMN sequence flow for layout and arrows.
 * `sequence_flow` is derived from the `sequence_to` field and is stored
 * in the same direction it renders: source -> target. Association
 * synapses (`serves`, `enacts`, `gated_by`, `tests`, …) remain visible
 * in detail panes, but they do not draw process arrows on this canvas.
 */
const SEQUENCE_FLOW_SYNAPSES: ReadonlySet<string> = new Set(["sequence_flow"]);

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

function miniMapShapeForBpmn(shape: BpmnShape): FullLayoutMiniMapShape {
  switch (shape) {
    case "circle":
    case "diamond":
    case "document":
    case "rounded":
      return shape;
    case "rectangle":
    case "task":
    case "milestone":
      return "rect";
    default:
      return "rect";
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
}

interface BpmnLaneData {
  lane: BpmnLane;
  height: number;
  width: number;
  labelWidth: number;
  referenceNumber?: number;
  isMilestoneBand?: boolean;
  isArtifactsBand?: boolean;
  onLaneClick?: (lane: BpmnLane) => void;
}

interface BpmnPoolHeaderData {
  pool: BpmnPool;
  width: number;
  height: number;
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
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        background: bg,
        borderTop: `2px solid ${borderColor}`,
        borderBottom: `1px solid ${borderColor}`,
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
          borderRight: "1px solid var(--color-border)",
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
 * row at the top of every neuron card. Only actor lanes have a
 * single owning neuron (the Principal), so they get the type +
 * lifecycle pair. Bands (milestone / artifacts) are structural
 * containers that hold a set of neurons — labelling the band itself
 * with one of those neuron types is misleading, so we render nothing.
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

function BpmnRectangleNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: `2px solid ${stroke}`,
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
        border: `2px solid ${stroke}`,
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

// BPMN Task — rounded rectangle. Sits between the sharp Rectangle (a
// policy box) and the fully-pill Rounded (an Idea capsule); the radius
// matches the OMG BPMN 2.0 task glyph.
function BpmnTaskNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
      {...graphReferenceAttributes(data)}
      style={{
        width: "100%",
        height: "100%",
        background: "#fff",
        border: `2px solid ${stroke}`,
        borderRadius: 12,
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
        border: `1px solid ${stroke}`,
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
          border: `2px solid ${stroke}`,
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
        <polygon points="50,2 98,50 50,98 2,50" fill="#fff" stroke={stroke} strokeWidth={2} />
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
          strokeWidth={2}
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
    "data-neuron-href": data.node.href ?? undefined,
    "data-neuron-id": data.node.id,
    "data-neuron-label": data.node.name ?? data.node.id,
    "data-neuron-lifecycle": data.node.lifecycle ?? "active",
    "data-neuron-type": data.node.entity_type,
  };
}

/**
 * Tag row floated centered over the TOP edge of a BPMN shape (type
 * pill + lifecycle pill) and reference-number badge centered over the
 * BOTTOM edge. Shared with the Graph perspective via
 * `~/components/neuron-badges` so both perspectives read the same.
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
