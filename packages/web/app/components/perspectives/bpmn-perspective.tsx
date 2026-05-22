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

import { Handle, MarkerType, Position } from "@xyflow/react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { OverviewGraphLink } from "~/components/overview-graph";
import type { BpmnLane, BpmnNode, BpmnShape } from "~/lib/bpmn-perspective.server";
import {
  type GraphReferenceItem,
  clearGraphReferences,
  publishGraphReferences,
} from "~/lib/graph-references";
import { lifecycleColor, lifecycleLabel, textOnLifecycle } from "~/lib/neuron-colors";
import "@xyflow/react/dist/style.css";

interface BpmnPerspectiveProps {
  lanes: BpmnLane[];
  nodes: BpmnNode[];
  links: OverviewGraphLink[];
  onNeuronClick?: (node: BpmnNode) => void;
  /**
   * Page-level lifecycle filter set. Nodes whose lifecycle isn't in
   * this set are excluded; lanes that end up empty after filtering
   * are dropped from the lane list. When omitted, every node is
   * shown.
   */
  visibleLifecycles?: Set<string>;
}

const LANE_HEIGHT = 140;
const LANE_LABEL_WIDTH = 140;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 60;
const NODE_GAP_Y = 20; // padding above/below row inside the lane
const BPMN_REFERENCE_ZOOM = 0.35;
const MAX_GRAPH_REFERENCES = 120;

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
  MiniMap: typeof import("@xyflow/react").MiniMap;
}

export function BpmnPerspective({
  lanes,
  nodes,
  links,
  onNeuronClick,
  visibleLifecycles,
}: BpmnPerspectiveProps) {
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

  // Drop nodes whose lifecycle is filtered out, then drop empty
  // lanes so the lane stack collapses cleanly. Links are filtered
  // by the existing nodeSet check inside layOutBpmn.
  const { filteredNodes, filteredLanes } = useMemo(() => {
    if (!visibleLifecycles) return { filteredNodes: nodes, filteredLanes: lanes };
    const fn = nodes.filter((n) => visibleLifecycles.has(n.lifecycle ?? "active"));
    const lanesWithNodes = new Set(fn.map((n) => n.laneId));
    const fl = lanes.filter((l) => lanesWithNodes.has(l.id));
    return { filteredNodes: fn, filteredLanes: fl };
  }, [nodes, lanes, visibleLifecycles]);

  useEffect(() => {
    let alive = true;
    import("@xyflow/react").then((mod) => {
      if (!alive) return;
      setFlow({
        ReactFlow: mod.ReactFlow,
        Background: mod.Background,
        Controls: mod.Controls,
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
    () => layOutBpmn(filteredLanes, filteredNodes, links),
    [filteredLanes, filteredNodes, links],
  );
  const nodeTypes = useMemo(
    () => ({
      bpmnLane: BpmnLaneNode,
      bpmnCircle: BpmnCircleNode,
      bpmnDiamond: BpmnDiamondNode,
      bpmnRectangle: BpmnRectangleNode,
      bpmnDocument: BpmnDocumentNode,
      bpmnRounded: BpmnRoundedNode,
    }),
    [],
  );
  const nodeById = useMemo(() => new Map(filteredNodes.map((n) => [n.id, n])), [filteredNodes]);

  const graphReferences = useMemo<GraphReferenceItem[]>(() => {
    if (viewport.zoom < BPMN_REFERENCE_ZOOM) return [];
    return filteredNodes
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
      .slice(0, MAX_GRAPH_REFERENCES)
      .map((entry, index) => ({
        number: index + 1,
        id: entry.node.id,
        entity_type: entry.node.entity_type,
        label: entry.node.name ?? entry.node.id,
        lifecycle: entry.node.lifecycle ?? "active",
        href: entry.node.href ?? null,
      }));
  }, [filteredNodes, layout.nodePositions, viewport, graphSize]);

  const referenceNumberByNodeId = useMemo(
    () => new Map(graphReferences.map((reference) => [reference.id, reference.number])),
    [graphReferences],
  );

  const flowNodes = useMemo(
    () =>
      layout.flowNodes.map((node) => {
        const referenceNumber = referenceNumberByNodeId.get(node.id);
        if (!referenceNumber || !nodeById.has(node.id)) return node;
        return {
          ...node,
          data: { ...node.data, referenceNumber },
        };
      }),
    [layout.flowNodes, referenceNumberByNodeId, nodeById],
  );

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    publishGraphReferences(graphId, "bpmn", graphReferences);
  }, [graphReferences]);

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    return () => clearGraphReferences(graphId);
  }, []);

  if (filteredLanes.length === 0 || filteredNodes.length === 0) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center rounded-md border border-border bg-input text-xs italic text-muted-foreground">
        No neurons assigned to any swim lane yet. Add `actor_id`, `decided_by`, or `wanted_by` to
        neurons to populate this perspective.
      </div>
    );
  }

  return (
    <div
      ref={graphRef}
      className="relative h-full min-h-[420px] w-full overflow-hidden rounded-md border border-border bg-input"
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
            if (target && onNeuronClick) {
              onNeuronClick(target);
              return;
            }
            if (target?.href) navigate(target.href);
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Flow.Background gap={24} size={1} />
          <Flow.Controls position="top-right" showInteractive={false} />
          <Flow.MiniMap
            pannable
            zoomable
            maskColor="rgba(0, 0, 0, 0.35)"
            nodeColor={(n: { id: string }) => {
              const found = nodeById.get(n.id);
              return found ? lifecycleColor(found.lifecycle) : "#d4d4d4";
            }}
            nodeStrokeWidth={2}
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
}

function layOutBpmn(lanes: BpmnLane[], nodes: BpmnNode[], links: OverviewGraphLink[]): BpmnLayout {
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
  const laneWidth = LANE_LABEL_WIDTH + (maxColumn + 1) * (NODE_WIDTH + NODE_GAP_X) + NODE_GAP_X;

  const flowNodes: FlowNode[] = [];
  const laneYById = new Map<string, number>();
  const nodePositions = new Map<string, { x: number; y: number }>();

  // Emit lane parent nodes first; child neurons reference parentId.
  lanes.forEach((lane, laneIndex) => {
    const laneY = laneIndex * LANE_HEIGHT;
    laneYById.set(lane.id, laneY);
    flowNodes.push({
      id: laneNodeId(lane.id),
      type: "bpmnLane",
      position: { x: 0, y: laneY },
      data: { lane, height: LANE_HEIGHT, width: laneWidth, labelWidth: LANE_LABEL_WIDTH },
      draggable: false,
      selectable: false,
      connectable: false,
      initialWidth: laneWidth,
      initialHeight: LANE_HEIGHT,
      style: { width: laneWidth, height: LANE_HEIGHT, zIndex: 0, padding: 0 },
    });
  });

  // Emit neuron nodes nested in their lane.
  for (const lane of lanes) {
    const list = orderedByLane.get(lane.id) ?? [];
    for (const node of list) {
      const column = columnByNode.get(node.id) ?? 0;
      const x = LANE_LABEL_WIDTH + column * (NODE_WIDTH + NODE_GAP_X);
      const y = (LANE_HEIGHT - NODE_HEIGHT) / 2;
      const laneY = laneYById.get(node.laneId) ?? 0;
      nodePositions.set(node.id, { x, y: laneY + y });
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
        initialWidth: NODE_WIDTH,
        initialHeight: NODE_HEIGHT,
        style: { width: NODE_WIDTH, height: NODE_HEIGHT, zIndex: 1 },
      });
    }
  }

  const nodeSet = new Set(nodes.map((n) => n.id));
  const flowEdges: FlowEdge[] = links
    .filter((link) => nodeSet.has(link.source) && nodeSet.has(link.target))
    .map((link, index) => {
      return {
        id: `${link.source}-${link.target}-${index}`,
        source: link.source,
        target: link.target,
        type: "smoothstep",
        selectable: false,
        focusable: false,
        interactionWidth: 0,
        style: {
          stroke: "#262626",
          strokeWidth: 1.75,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
          color: "#262626",
        },
      };
    });

  return { flowNodes, flowEdges, nodePositions };
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
    (predecessors.get(link.target) as string[]).push(link.source);
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
    default:
      return "bpmnRectangle";
  }
}

function laneNodeId(laneId: string): string {
  return `lane:${laneId}`;
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
}

function BpmnLaneNode({ data }: { data: BpmnLaneData }) {
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        background: "rgba(0, 0, 0, 0.03)",
        borderTop: "1px dashed var(--color-border)",
        borderBottom: "1px dashed var(--color-border)",
      }}
    >
      <div
        style={{
          width: data.labelWidth,
          height: "100%",
          background: "rgba(0, 0, 0, 0.04)",
          borderRight: "1px solid var(--color-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 600,
          textAlign: "center",
          padding: "0 8px",
          boxSizing: "border-box",
        }}
        title={data.lane.label}
      >
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
      <ReferenceBadge data={data} />
      <TypeBadge node={data.node} />
      <LifecycleBadge node={data.node} />
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
      <ReferenceBadge data={data} />
      <TypeBadge node={data.node} />
      <LifecycleBadge node={data.node} />
      <ShapeLabel node={data.node} />
      {commonHandles()}
    </div>
  );
}

function BpmnCircleNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  // Circles are drawn at the lane's vertical center; we shrink width
  // visually to look round but the React Flow box stays NODE_WIDTH
  // for layout consistency.
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
      <ReferenceBadge data={data} circular />
      <div
        style={{
          width: NODE_HEIGHT,
          height: NODE_HEIGHT,
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
        <TypeBadge node={data.node} circular />
        <LifecycleBadge node={data.node} circular />
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
      <ReferenceBadge data={data} />
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
      <TypeBadge node={data.node} />
      <LifecycleBadge node={data.node} />
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
      <ReferenceBadge data={data} />
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
      <TypeBadge node={data.node} />
      <LifecycleBadge node={data.node} />
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

function ReferenceBadge({ data, circular = false }: { data: BpmnNodeData; circular?: boolean }) {
  if (!data.referenceNumber) return null;
  return (
    <span
      aria-label={`Graph reference ${data.referenceNumber}: ${data.node.name ?? data.node.id}`}
      className="pointer-events-none absolute z-30 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
      style={circular ? { left: "calc(50% - 42px)", top: -10 } : { left: -10, top: -10 }}
      title={`Graph reference ${data.referenceNumber}`}
    >
      {data.referenceNumber}
    </span>
  );
}

/**
 * Shared style for both the type badge and the lifecycle badge —
 * they're two pills of the same lifecycle color, paired with the
 * shape stroke (also lifecycle color) to form a consistent color
 * triplet. Text identifies what the pill represents (type vs stage).
 */
function badgeStyle(
  node: BpmnNode,
  anchor: "left" | "right" | "centered-top" | "centered-bottom",
): CSSProperties {
  const bg = lifecycleColor(node.lifecycle);
  const fg = textOnLifecycle(node.lifecycle);
  const base: CSSProperties = {
    position: "absolute",
    background: bg,
    color: fg,
    fontSize: 9,
    fontWeight: 700,
    lineHeight: 1,
    padding: "2px 5px",
    borderRadius: 3,
    letterSpacing: 0.3,
    pointerEvents: "none",
    textTransform: "uppercase",
    zIndex: 2,
    whiteSpace: "nowrap",
  };
  switch (anchor) {
    case "left":
      return { ...base, top: -7, left: 6 };
    case "right":
      return { ...base, top: -7, right: 6 };
    case "centered-top":
      return { ...base, top: -8, left: "50%", transform: "translateX(-50%)" };
    case "centered-bottom":
      return { ...base, bottom: -8, left: "50%", transform: "translateX(-50%)" };
  }
}

function TypeBadge({ node, circular = false }: { node: BpmnNode; circular?: boolean }) {
  return (
    <span style={badgeStyle(node, circular ? "centered-top" : "left")}>
      {labelForType(node.entity_type)}
    </span>
  );
}

function LifecycleBadge({ node, circular = false }: { node: BpmnNode; circular?: boolean }) {
  return (
    <span style={badgeStyle(node, circular ? "centered-bottom" : "right")}>
      {lifecycleLabel(node.lifecycle)}
    </span>
  );
}

function labelForType(type: string): string {
  switch (type) {
    case "intent":
      return "Intent";
    case "decision":
      return "Decision";
    case "action":
      return "Action";
    case "rule":
      return "Rule";
    case "state":
      return "State";
    case "log":
      return "Log";
    case "eval":
      return "Eval";
    case "reference":
      return "Ref";
    case "idea":
      return "Idea";
    default:
      return type;
  }
}
