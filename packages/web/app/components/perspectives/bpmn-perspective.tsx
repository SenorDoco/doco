// BPMN perspective — swim lanes, BPMN-inspired shapes, lifecycle
// coloring. Owned by torrenegra per the seeded perspectives row.
//
// Layout strategy:
//   • One horizontal lane per principal (plus an Unassigned lane).
//   • Lanes are React Flow parent nodes; neurons set parentId to nest
//     visually inside their lane.
//   • Within each lane, neurons are placed in a topological sweep:
//     incoming-edge predecessors land first, dangling nodes fall back
//     to created_at order. This gives a left-to-right flow without
//     pulling in a full ELK dependency for v1.
//   • Lifecycle color renders as the shape's stroke; the type icon
//     identifies the neuron type at a glance.
//
// Shape rendering uses custom React Flow node types — one component
// per shape (circle, diamond, rectangle, document, rounded). Handles
// sit on left/right edges so synapses connect cleanly regardless of
// lane vertical offset.

import { Handle, MarkerType, type MiniMapNodeProps, Position } from "@xyflow/react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  type CSSProperties,
  type ComponentType,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { NodeBadgeRow, ReferenceNumberBadge } from "~/components/neuron-badges";
import type { OverviewGraphLink } from "~/components/overview-graph";
import type { BpmnLane, BpmnNode, BpmnPool, BpmnShape } from "~/lib/bpmn-perspective.server";
import {
  computeDepthFromCenter,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import {
  type GraphReferenceItem,
  clearGraphReferences,
  publishGraphReferences,
} from "~/lib/graph-references";
import { lifecycleColor, lifecycleLabel } from "~/lib/neuron-colors";
import { highestRanked, pageRank } from "~/lib/pagerank";
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
   * Per-neuron global PageRank score on the doco's synapse graph,
   * emitted by `loadBpmnGraph`. When `centerId` is set, the client
   * re-runs PageRank with the teleport vector biased to that focal
   * neuron, and re-picks the primary intent for each multi-intent
   * node — so neurons can swap pools as the user clicks into the
   * graph without a round-trip to the server.
   */
  globalPagerank?: Record<string, number>;
  onNeuronClick?: (node: BpmnNode) => void;
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
   * Lifecycles present in the underlying data. Drives which
   * checkboxes appear in the in-canvas filter overlay. Required when
   * `visibleLifecycles` is provided so the overlay can render the
   * controls.
   */
  availableLifecycles?: Iterable<string>;
  /** Called when the user toggles a lifecycle stage. */
  onLifecycleToggle?: (lifecycle: string) => void;
  /**
   * When set, the BPMN canvas fades non-neighbours of this neuron
   * based on BFS depth (1st-degree solid, 2nd 75%, 3rd 50%, 4+ 25%).
   * Edges fade with their deepest endpoint. When null/undefined,
   * every node and edge renders at full opacity.
   */
  centerId?: string | null;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
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
const NODE_WIDTH = 140;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 60;
const NODE_GAP_Y = 20; // padding above/below row inside the lane
const BPMN_REFERENCE_ZOOM = 0.35;
const MAX_GRAPH_REFERENCES = 120;

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
  MiniMap: typeof import("@xyflow/react").MiniMap;
}

export function BpmnPerspective({
  pools,
  lanes: lanesRaw,
  nodes: nodesRaw,
  links,
  globalPagerank,
  onNeuronClick,
  onCenterChange,
  visibleLifecycles,
  availableLifecycles,
  onLifecycleToggle,
  centerId,
  isFullscreen,
  onToggleFullscreen,
}: BpmnPerspectiveProps) {
  // ── Personalized PageRank re-pool ─────────────────────────────────
  // The server picked each multi-intent neuron's primary intent using
  // GLOBAL PageRank. When the user clicks into a focal neuron, we
  // re-run PageRank with the teleport vector biased to that focal
  // node and re-pick the primary intent for each multi-intent neuron;
  // that may move them into a different pool. The pool list itself
  // doesn't change order (server-emitted order is keyed to global PR,
  // which is the most stable read), but a node migrating to a pool
  // that didn't have its actor lane yet adds the lane on the fly.
  const { lanes, nodes } = useMemo(() => {
    const hasFocal = !!centerId && nodesRaw.some((n) => n.id === centerId);
    const multiIntentNodes = nodesRaw.filter((n) => (n.intent_ids?.length ?? 0) > 1);
    if (!hasFocal || multiIntentNodes.length === 0) {
      return { lanes: lanesRaw, nodes: nodesRaw };
    }

    const personalized = pageRank(
      nodesRaw.map((n) => ({ id: n.id })),
      links,
      { personalization: new Map([[centerId as string, 1]]) },
    );

    // Build new node list with adjusted pool_id / laneId for any
    // multi-intent neuron whose primary intent changed under
    // personalized PR. base_id (the part after "::") is preserved —
    // the actor lane within the destination pool keeps the same
    // Principal label, it just lives in a different pool.
    const movedNodes = nodesRaw.map((node) => {
      const candidates = node.intent_ids;
      if (!candidates || candidates.length < 2) return node;
      const newPrimary = highestRanked(candidates, personalized);
      if (!newPrimary) return node;
      const currentPoolIntent = node.pool_id.startsWith("pool:")
        ? node.pool_id.slice("pool:".length)
        : null;
      if (newPrimary === currentPoolIntent) return node;
      const newPoolId = `pool:${newPrimary}`;
      const colonIdx = node.laneId.indexOf("::");
      const base = colonIdx >= 0 ? node.laneId.slice(colonIdx + 2) : node.laneId;
      const newLaneId = `${newPoolId}::${base}`;
      return { ...node, pool_id: newPoolId, laneId: newLaneId };
    });

    // Synthesize any missing lanes. When a node moves to a destination
    // pool that already had the same actor lane (e.g. alice already
    // had work in the destination pool), no new lane needed. Otherwise
    // clone the matching base lane from any pool that has it and
    // re-prefix to the destination pool.
    const existingLaneIds = new Set(lanesRaw.map((l) => l.id));
    const lanesByBase = new Map<string, BpmnLane>();
    for (const l of lanesRaw) {
      if (!lanesByBase.has(l.base_id)) lanesByBase.set(l.base_id, l);
    }
    const synthesizedLanes: BpmnLane[] = [];
    for (const node of movedNodes) {
      if (existingLaneIds.has(node.laneId)) continue;
      const colonIdx = node.laneId.indexOf("::");
      if (colonIdx < 0) continue;
      const base = node.laneId.slice(colonIdx + 2);
      const template = lanesByBase.get(base);
      if (!template) continue;
      synthesizedLanes.push({
        id: node.laneId,
        pool_id: node.pool_id,
        base_id: template.base_id,
        label: template.label,
        kind: template.kind,
      });
      existingLaneIds.add(node.laneId);
    }
    return {
      lanes: synthesizedLanes.length > 0 ? [...lanesRaw, ...synthesizedLanes] : lanesRaw,
      nodes: movedNodes,
    };
  }, [lanesRaw, nodesRaw, links, centerId]);
  const navigate = useNavigate();
  const graphRef = useRef<HTMLDivElement>(null);
  const graphReferenceIdRef = useRef(`bpmn-${Math.random().toString(36).slice(2)}`);
  const [Flow, setFlow] = useState<FlowModule | null>(null);
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const [graphSize, setGraphSize] = useState<GraphSize>({ width: 1, height: 1 });
  const hasFitRef = useRef(false);
  const updateViewport = (next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  };

  // Drop nodes whose lifecycle is filtered out. Lanes are NEVER
  // dropped — every Principal lane stays visible regardless of which
  // nodes are filtered in. Matches the server-side guarantee that
  // loadBpmnGraph emits a lane for every Principal in the doco, even
  // when zero neurons are assigned to them. Links are still filtered
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
        MiniMap: mod.MiniMap,
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
  const MiniMapNode = useMemo(() => makeBpmnMiniMapNode(nodeById), [nodeById]);

  const graphReferences = useMemo<GraphReferenceItem[]>(() => {
    if (viewport.zoom < BPMN_REFERENCE_ZOOM) return [];
    // Lanes that map to a real principal are first-class references
    // — number them ahead of the shapes, in lane display order, so a
    // viewer can jump straight to the swimlane owner from the sidebar
    // before the per-shape numbers begin.
    const laneRefs: GraphReferenceItem[] = filteredLanes
      .filter((lane) => isActorLane(lane))
      .map((lane, index) => ({
        number: index + 1,
        id: lane.id,
        entity_type: "principal",
        label: lane.label,
        lifecycle: "active",
        href: null,
      }));
    const remaining = Math.max(0, MAX_GRAPH_REFERENCES - laneRefs.length);
    const nodeRefs: GraphReferenceItem[] = filteredNodes
      .flatMap((node) => {
        const position = layout.nodePositions.get(node.id);
        if (!position || !isNodeVisibleInViewport(position, viewport, graphSize)) return [];
        return [
          {
            node,
            position: screenPosition(position, viewport),
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
      .slice(0, remaining)
      .map((entry, index) => ({
        number: laneRefs.length + index + 1,
        id: entry.node.id,
        entity_type: entry.node.entity_type,
        label: entry.node.name ?? entry.node.id,
        lifecycle: entry.node.lifecycle ?? "active",
        href: entry.node.href ?? null,
      }));
    return [...laneRefs, ...nodeRefs];
  }, [filteredLanes, filteredNodes, layout.nodePositions, viewport, graphSize]);

  const referenceNumberByEntityId = useMemo(
    () => new Map(graphReferences.map((reference) => [reference.id, reference.number])),
    [graphReferences],
  );

  const flowNodes = useMemo(
    () =>
      layout.flowNodes.map((node) => {
        // Lane FlowNodes carry data.lane; shape FlowNodes carry data.node.
        // Each pulls its reference number from the unified map by the
        // underlying entity id (principal_<ulid> or neuron id).
        const laneData = (node.data as { lane?: BpmnLane }).lane;
        if (laneData) {
          const referenceNumber = referenceNumberByEntityId.get(laneData.id);
          if (!referenceNumber) return node;
          return { ...node, data: { ...node.data, referenceNumber } };
        }
        const referenceNumber = referenceNumberByEntityId.get(node.id);
        if (!referenceNumber || !nodeById.has(node.id)) return node;
        return { ...node, data: { ...node.data, referenceNumber } };
      }),
    [layout.flowNodes, referenceNumberByEntityId, nodeById],
  );

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    publishGraphReferences(graphId, "bpmn", graphReferences);
  }, [graphReferences]);

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    return () => clearGraphReferences(graphId);
  }, []);

  if (filteredLanes.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center rounded-md rounded-tl-none border border-border bg-white text-center text-sm font-medium text-muted-foreground">
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
        const isBand = lane.kind !== "principal";
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
            style={{ top, height: railHeight, width: SWIM_RAIL_WIDTH }}
            data-bpmn-lane-rail={lane.id}
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
                textTransform: isBand ? "uppercase" : "none",
                letterSpacing: isBand ? 0.6 : 0,
              }}
            >
              {lane.label}
            </span>
          </div>
        );
      })
    : null;

  return (
    <div
      ref={graphRef}
      className="relative h-full min-h-0 w-full flex-1 overflow-hidden rounded-md rounded-tl-none border border-border bg-white"
    >
      {Flow ? (
        <Flow.ReactFlow
          nodes={flowNodes}
          edges={layout.flowEdges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          minZoom={0.1}
          maxZoom={2.0}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          preventScrolling
          onInit={(instance: {
            fitView?: (options?: { padding?: number }) => void;
            getViewport?: () => FlowViewport;
          }) => {
            if (!hasFitRef.current) {
              instance.fitView?.({ padding: 0.18 });
              hasFitRef.current = true;
            }
            const current = instance.getViewport?.();
            if (current) updateViewport(current);
          }}
          onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
          onNodeClick={(_e: unknown, node: { id: string }) => {
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
          <Flow.Controls position="top-right" showInteractive={false} style={{ top: 44 }}>
            {onToggleFullscreen ? (
              <Flow.ControlButton
                onClick={onToggleFullscreen}
                title={isFullscreen ? "Exit full screen" : "Enter full screen"}
                aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
              >
                {isFullscreen ? <Minimize2 /> : <Maximize2 />}
              </Flow.ControlButton>
            ) : null}
          </Flow.Controls>
          <Flow.MiniMap
            pannable
            zoomable
            maskColor="rgba(0, 0, 0, 0.35)"
            nodeComponent={MiniMapNode}
            nodeStrokeWidth={1}
            style={{
              width: 140,
              height: 100,
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          />
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
          aria-hidden="true"
        >
          {laneRails}
        </div>
      ) : null}
      {/* Lifecycle filter overlay — lives inside the BPMN canvas so the
          aside can fill its container vertically (no row above or below
          the perspective eating space). Only renders when the parent
          provides controlled lifecycle state + the toggle callback. */}
      {visibleLifecycles && availableLifecycles && onLifecycleToggle && Flow ? (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10">
          <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/90 px-2 py-1 text-xs shadow-sm backdrop-blur">
            <span className="text-muted-foreground">Life cycle:</span>
            {Array.from(availableLifecycles).map((lifecycle) => {
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
                    onChange={() => onLifecycleToggle(lifecycle)}
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
      ) : null}
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
  }>;
}

const POOL_HEADER_HEIGHT = 32;
const POOL_GAP = 16;

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
  const focalDepthByNode = computeDepthFromCenter(nodes, links, centerId);
  const focalActive = hasFocalNode(centerId, nodes);

  const byLane = new Map<string, BpmnNode[]>();
  for (const lane of lanes) byLane.set(lane.id, []);
  for (const node of nodes) {
    const list = byLane.get(node.laneId);
    if (list) list.push(node);
  }

  // Compute one global column per node so that nodes in the same
  // topological depth line up vertically across lanes — left-to-right
  // flow reads cleanly even when a synapse crosses from alice's lane
  // into bob's lane. depth(n) = 1 + max(depth(predecessors)) or 0 if
  // none. Cycle survivors are placed at depth(0) so they still appear.
  const depthByNode = computeDepths(nodes, links);

  // Within each lane, nodes are sorted by depth so they appear left to
  // right regardless of created_at. Then we pack rows: if two nodes
  // in the same lane share a depth (unlikely but possible), we shove
  // the second one one column to the right.
  const orderedByLane = new Map<string, BpmnNode[]>();
  for (const lane of lanes) orderedByLane.set(lane.id, []);
  for (const node of nodes) {
    const list = orderedByLane.get(node.laneId);
    if (list) list.push(node);
  }
  for (const list of orderedByLane.values()) {
    list.sort((a, b) => {
      const da = depthByNode.get(a.id) ?? 0;
      const db = depthByNode.get(b.id) ?? 0;
      if (da !== db) return da - db;
      const at = a.created_at ? Date.parse(a.created_at) : 0;
      const bt = b.created_at ? Date.parse(b.created_at) : 0;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
  }

  // For each node, the absolute column position is its depth — but if
  // two nodes in the same lane share a depth, the later one bumps
  // right by one column to avoid overlap.
  const columnByNode = new Map<string, number>();
  for (const list of orderedByLane.values()) {
    let lastColumn = -1;
    for (const node of list) {
      const wanted = depthByNode.get(node.id) ?? 0;
      const column = Math.max(wanted, lastColumn + 1);
      columnByNode.set(node.id, column);
      lastColumn = column;
    }
  }

  const maxColumn = Math.max(0, ...Array.from(columnByNode.values()));

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
  const dynLaneHeight = Math.max(LANE_HEIGHT, maxNodeHeight + NODE_GAP_Y * 2);
  const laneWidth = LANE_LABEL_WIDTH + (maxColumn + 1) * columnStep + NODE_GAP_X;

  const flowNodes: FlowNode[] = [];
  const laneYById = new Map<string, number>();
  const laneHeightById = new Map<string, number>();
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
    if (poolLanes.length === 0) continue; // empty pool — server already drops these in practice
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
      // All lanes (actor + milestone + artifacts band) now use the
      // same dynamic height. States render as Task glyphs (same size
      // as Actions), so the milestone band needs full lane height to
      // fit them; the artifacts band follows the same rule for
      // consistency.
      const laneHeight = dynLaneHeight;

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
    });
  }

  // Emit neuron nodes nested in their lane.
  for (const lane of lanes) {
    const list = orderedByLane.get(lane.id) ?? [];
    const containerHeight = laneHeightById.get(lane.id) ?? dynLaneHeight;
    for (const node of list) {
      const column = columnByNode.get(node.id) ?? 0;
      const size = sizeByNode.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
      // Center the node within its column slot so wider/narrower
      // nodes still line up by their middle on the same x axis.
      const slotX = LANE_LABEL_WIDTH + column * columnStep;
      const x = slotX + (maxNodeWidth - size.width) / 2;
      const y = (containerHeight - size.height) / 2;
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
    .map((link, index) => {
      // Some synapses are stored downstream→upstream in the data but
      // their BPMN sequence flow runs the other way:
      //
      // - `serves` is stored Action→Intent (Action serves Intent), but
      //   the Intent is the start event at the origin of the flow —
      //   arrows fan *out* from it.
      // - `enacts` is stored Action→Decision (Action enacts a prior
      //   Decision), but the Decision is the gateway and the Action is
      //   the downstream branch — arrows go from the gateway *to* each
      //   branch.
      //
      // For both, flip the visual edge so the arrowhead lands on the
      // downstream side. The underlying synapse direction in the data
      // is unchanged; only the rendered edge is swapped. (And these
      // matches the depth-walk direction: gateways/start-events end up
      // at the lower depth, branches/actions at the higher depth.)
      const flip = link.synapse_type === "serves" || link.synapse_type === "enacts";
      const source = flip ? link.target : link.source;
      const target = flip ? link.source : link.target;
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
        // bezier (vs the prior smoothstep) curves naturally away from
        // its endpoints, which spreads convergent fans (many edges into
        // a single node) and divergent fans (many edges out of one)
        // visually. Orthogonal smoothstep routing tended to stack
        // multiple edges on the same segment near the endpoints —
        // crossings still happen but parallel runs no longer overlap.
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
    const height = laneHeightById.get(lane.id) ?? dynLaneHeight;
    return { id: lane.id, pool_id: lane.pool_id, label: lane.label, y, height, kind: lane.kind };
  });

  return { flowNodes, flowEdges, nodePositions, lanes: laneGeometry, poolGeometry };
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
): boolean {
  const screen = screenPosition(position, viewport);
  const scaledWidth = NODE_WIDTH * viewport.zoom;
  const scaledHeight = NODE_HEIGHT * viewport.zoom;
  return (
    screen.x > -scaledWidth &&
    screen.y > -scaledHeight &&
    screen.x < size.width + scaledWidth &&
    screen.y < size.height + scaledHeight
  );
}

/**
 * Longest-path depth for each node. A node with no predecessors has
 * depth 0; otherwise it sits one beyond the max depth of its
 * predecessors. Cycle survivors (no zero-indegree entry point) fall
 * back to depth 0 and are sorted by created_at within their lane.
 */
/**
 * Synapse types that express **causal sequence flow** for BPMN layout.
 * These are the only edges that move a neuron's horizontal column;
 * every other synapse type (`serves`, `performed_by`, `gated_by`,
 * `tests`, `consults`, `has_parent`, …) renders an arrow but doesn't
 * push the target node to a later column.
 *
 * All three store the link successor → predecessor in the data:
 *
 * - `A.follows=[B]` is `{from: A, to: B}` meaning B happens before A.
 * - `Action.triggered_by=[B]` is `{from: Action, to: B}` meaning B
 *   happened first and triggered the Action.
 * - `Action.decision_ids=[D]` is `{from: Action, to: D}` and semantically
 *   means "the Action enacts a prior Decision" — i.e. the Decision is
 *   a gateway the Action realizes a branch of, so the Decision came
 *   first. Decision is the predecessor.
 *
 * Depth reads `link.target` as the predecessor for all three: this
 * puts gateways LEFT of the branches that enact them and triggers
 * LEFT of the work they triggered — both BPMN-correct.
 *
 * If you want an upstream Action to render LEFT of a gateway it
 * leads to (not enacts), encode that in the data as
 * `Decision.follows = [Action]`, not `Action.decision_ids =
 * [Decision]` — the latter says "Action enacts a prior Decision"
 * which is the opposite direction.
 */
const SEQUENCE_FLOW_SYNAPSES: ReadonlySet<string> = new Set(["follows", "triggered_by", "enacts"]);

function computeDepths(
  nodes: readonly BpmnNode[],
  links: readonly OverviewGraphLink[],
): Map<string, number> {
  const depth = new Map<string, number>();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const predecessors = new Map<string, string[]>();
  for (const id of nodeIds) predecessors.set(id, []);
  for (const link of links) {
    if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) continue;
    if (!SEQUENCE_FLOW_SYNAPSES.has(link.synapse_type)) continue;
    (predecessors.get(link.source) as string[]).push(link.target);
  }
  // Memoized DFS — handles DAGs and is safe against cycles via the
  // `visiting` guard which treats a back-edge predecessor as depth 0.
  const visiting = new Set<string>();
  function depthOf(id: string): number {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const preds = predecessors.get(id) ?? [];
    let max = 0;
    for (const pred of preds) {
      const d = depthOf(pred) + 1;
      if (d > max) max = d;
    }
    visiting.delete(id);
    depth.set(id, max);
    return max;
  }
  for (const id of nodeIds) depthOf(id);
  // BFS-from-start fallback. The server tags each node with
  // `bfs_depth` — its undirected distance from the nearest start
  // anchor (Intent / kind=initial State) over the full synapse graph.
  // For neurons with no incoming sequence-flow synapse, this is the
  // only signal that places them somewhere other than column 0. Take
  // MAX(sequence-flow depth, bfs_depth) so explicit `follows` chains
  // (which can produce deeper depths) still win when they exist.
  for (const node of nodes) {
    const bfs = node.bfs_depth;
    if (bfs === undefined || bfs <= 0) continue;
    const current = depth.get(node.id) ?? 0;
    if (bfs > current) depth.set(node.id, bfs);
  }
  return depth;
}

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
}

interface BpmnLaneData {
  lane: BpmnLane;
  height: number;
  width: number;
  labelWidth: number;
  referenceNumber?: number;
  isMilestoneBand?: boolean;
  isArtifactsBand?: boolean;
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
        padding: "0 14px",
        boxSizing: "border-box",
        fontSize: 12,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        color: isUnassigned ? "var(--color-muted-foreground, #525252)" : "#1f2937",
      }}
      title={data.pool.label}
    >
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
        className="relative"
        style={{
          width: data.labelWidth,
          height: "100%",
          background: labelBg,
          borderRight: "1px solid var(--color-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 600,
          textAlign: "center",
          padding: "0 8px",
          boxSizing: "border-box",
          textTransform: isBand ? "uppercase" : "none",
          letterSpacing: isBand ? 0.6 : 0,
        }}
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
        {data.lane.label}
      </div>
    </div>
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
  // The wrapper is the React Flow box; we rotate an inner square 45°
  // for the diamond outline, but keep a counter-rotated label so text
  // reads horizontally.
  const inner = Math.min(NODE_WIDTH, NODE_HEIGHT) - 6;
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
      <div
        style={{
          width: inner,
          height: inner,
          background: "#fff",
          border: `2px solid ${stroke}`,
          transform: "rotate(45deg)",
          position: "absolute",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      />
      <div
        style={{
          position: "relative",
          width: NODE_WIDTH - 16,
          height: NODE_HEIGHT - 16,
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

// MiniMap node component — renders each canvas node in its actual BPMN
// shape so the minimap is a true scaled-down silhouette of the
// perspective, not a grid of identical rectangles. Lane parents render
// as faint horizontal bands to suggest the swimlane structure without
// dominating the SVG.
function makeBpmnMiniMapNode(nodeById: Map<string, BpmnNode>): ComponentType<MiniMapNodeProps> {
  return function BpmnMiniMapNode({
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
    const classes = ["react-flow__minimap-node", selected ? "selected" : "", className]
      .filter(Boolean)
      .join(" ");
    if (id.startsWith("lane:")) {
      return (
        <g className={classes} shapeRendering={shapeRendering}>
          <rect
            x={x}
            y={y}
            width={width}
            height={height}
            fill="rgba(0,0,0,0.04)"
            stroke="rgba(0,0,0,0.08)"
            strokeWidth={strokeWidth ?? 1}
            style={{ vectorEffect: "non-scaling-stroke" }}
          />
        </g>
      );
    }
    const node = nodeById.get(id);
    if (!node) return null;
    const fill = lifecycleColor(node.lifecycle);
    const stroke = strokeColor ?? "rgba(0,0,0,0.5)";
    const sw = strokeWidth ?? 1;
    const cx = x + width / 2;
    const cy = y + height / 2;
    switch (node.shape) {
      case "circle": {
        const r = Math.min(width, height) / 2;
        return (
          <g className={classes} shapeRendering={shapeRendering}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{ vectorEffect: "non-scaling-stroke" }}
            />
          </g>
        );
      }
      case "diamond": {
        const points = `${cx},${y} ${x + width},${cy} ${cx},${y + height} ${x},${cy}`;
        return (
          <g className={classes} shapeRendering={shapeRendering}>
            <polygon
              points={points}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{ vectorEffect: "non-scaling-stroke" }}
            />
          </g>
        );
      }
      case "document": {
        // Rectangle with a wavy bottom edge — matches BpmnDocumentNode's
        // canvas silhouette, simplified for the minimap's small footprint.
        const dipDepth = Math.min(height * 0.18, 6);
        const baselineY = y + height - dipDepth;
        const midY = y + height - dipDepth / 2;
        const q1x = x + width * 0.25;
        const q2x = x + width * 0.75;
        const path = [
          `M${x},${y}`,
          `H${x + width}`,
          `V${baselineY}`,
          `Q${q2x},${y + height} ${cx},${midY}`,
          `Q${q1x},${y + height - dipDepth * 1.5} ${x},${baselineY}`,
          "Z",
        ].join(" ");
        return (
          <g className={classes} shapeRendering={shapeRendering}>
            <path
              d={path}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{ vectorEffect: "non-scaling-stroke" }}
            />
          </g>
        );
      }
      case "rounded": {
        const r = Math.min(width, height) / 2;
        return (
          <g className={classes} shapeRendering={shapeRendering}>
            <rect
              x={x}
              y={y}
              width={width}
              height={height}
              rx={r}
              ry={r}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{ vectorEffect: "non-scaling-stroke" }}
            />
          </g>
        );
      }
      case "task": {
        // BPMN Task glyph — modest corner radius.
        const r = Math.min(width, height) * 0.2;
        return (
          <g className={classes} shapeRendering={shapeRendering}>
            <rect
              x={x}
              y={y}
              width={width}
              height={height}
              rx={r}
              ry={r}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{ vectorEffect: "non-scaling-stroke" }}
            />
          </g>
        );
      }
      case "milestone": {
        // Compact rectangle with a thin stroke — milestones read as
        // labels on the band, not as flow shapes.
        return (
          <g className={classes} shapeRendering={shapeRendering}>
            <rect
              x={x}
              y={y}
              width={width}
              height={height}
              rx={2}
              ry={2}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{ vectorEffect: "non-scaling-stroke" }}
            />
          </g>
        );
      }
      default:
        return (
          <g className={classes} shapeRendering={shapeRendering}>
            <rect
              x={x}
              y={y}
              width={width}
              height={height}
              rx={2}
              ry={2}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{ vectorEffect: "non-scaling-stroke" }}
            />
          </g>
        );
    }
  };
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
      <NodeBadgeRow entityType={data.node.entity_type} lifecycle={data.node.lifecycle} />
      <ReferenceNumberBadge
        referenceNumber={data.referenceNumber}
        referenceLabel={data.node.name ?? data.node.id}
      />
    </>
  );
}
