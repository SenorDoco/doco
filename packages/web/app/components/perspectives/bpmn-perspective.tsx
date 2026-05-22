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

import { Handle, Position } from "@xyflow/react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { OverviewGraphLink } from "~/components/overview-graph";
import type { BpmnLane, BpmnNode, BpmnShape } from "~/lib/bpmn-perspective.server";
import { lifecycleColor, nodeTypeColor } from "~/lib/neuron-colors";
import "@xyflow/react/dist/style.css";

interface BpmnPerspectiveProps {
  lanes: BpmnLane[];
  nodes: BpmnNode[];
  links: OverviewGraphLink[];
}

const LANE_HEIGHT = 140;
const LANE_LABEL_WIDTH = 140;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 60;
const NODE_GAP_Y = 20; // padding above/below row inside the lane

interface FlowModule {
  ReactFlow: typeof import("@xyflow/react").ReactFlow;
  Background: typeof import("@xyflow/react").Background;
  Controls: typeof import("@xyflow/react").Controls;
  MiniMap: typeof import("@xyflow/react").MiniMap;
}

export function BpmnPerspective({ lanes, nodes, links }: BpmnPerspectiveProps) {
  const navigate = useNavigate();
  const [Flow, setFlow] = useState<FlowModule | null>(null);
  const hasFitRef = useRef(false);

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

  const layout = useMemo(() => layOutBpmn(lanes, nodes, links), [lanes, nodes, links]);
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
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  if (lanes.length === 0 || nodes.length === 0) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center rounded-md border border-border bg-input text-xs italic text-muted-foreground">
        No neurons assigned to any swim lane yet. Add `actor_id`, `decided_by`, or `wanted_by`
        to neurons to populate this perspective.
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[420px] w-full overflow-hidden rounded-md border border-border bg-input">
      {Flow ? (
        <Flow.ReactFlow
          nodes={layout.flowNodes}
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
          onInit={(instance: { fitView?: (options?: { padding?: number }) => void }) => {
            if (!hasFitRef.current) {
              instance.fitView?.({ padding: 0.18 });
              hasFitRef.current = true;
            }
          }}
          onNodeClick={(_e: unknown, node: { id: string }) => {
            const target = nodeById.get(node.id);
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
}

interface BpmnLayout {
  flowNodes: FlowNode[];
  flowEdges: FlowEdge[];
}

function layOutBpmn(
  lanes: BpmnLane[],
  nodes: BpmnNode[],
  links: OverviewGraphLink[],
): BpmnLayout {
  const byLane = new Map<string, BpmnNode[]>();
  for (const lane of lanes) byLane.set(lane.id, []);
  for (const node of nodes) {
    const list = byLane.get(node.laneId);
    if (list) list.push(node);
  }

  // Topological sort within the whole graph; then for each lane, use
  // the global topo order as the in-lane order. Ties fall back to
  // created_at, then id.
  const topoOrder = topoSort(nodes, links);
  const orderIndex = new Map<string, number>();
  topoOrder.forEach((id, index) => orderIndex.set(id, index));

  for (const list of byLane.values()) {
    list.sort((a, b) => {
      const ai = orderIndex.get(a.id) ?? Number.POSITIVE_INFINITY;
      const bi = orderIndex.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      const at = a.created_at ? Date.parse(a.created_at) : 0;
      const bt = b.created_at ? Date.parse(b.created_at) : 0;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
  }

  const maxColumns = Math.max(
    1,
    ...Array.from(byLane.values()).map((list) => list.length),
  );
  const laneWidth = LANE_LABEL_WIDTH + maxColumns * (NODE_WIDTH + NODE_GAP_X) + NODE_GAP_X;

  const flowNodes: FlowNode[] = [];

  // Emit lane parent nodes first; child neurons reference parentId.
  lanes.forEach((lane, laneIndex) => {
    flowNodes.push({
      id: laneNodeId(lane.id),
      type: "bpmnLane",
      position: { x: 0, y: laneIndex * LANE_HEIGHT },
      data: { lane, height: LANE_HEIGHT, width: laneWidth, labelWidth: LANE_LABEL_WIDTH },
      draggable: false,
      selectable: false,
      connectable: false,
      style: { width: laneWidth, height: LANE_HEIGHT, zIndex: 0, padding: 0 },
    });
  });

  // Emit neuron nodes nested in their lane.
  lanes.forEach((lane) => {
    const list = byLane.get(lane.id) ?? [];
    list.forEach((node, columnIndex) => {
      const x = LANE_LABEL_WIDTH + columnIndex * (NODE_WIDTH + NODE_GAP_X);
      const y = (LANE_HEIGHT - NODE_HEIGHT) / 2;
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
        style: { width: NODE_WIDTH, height: NODE_HEIGHT, zIndex: 1 },
      });
    });
  });

  const nodeSet = new Set(nodes.map((n) => n.id));
  const flowEdges: FlowEdge[] = links
    .filter((link) => nodeSet.has(link.source) && nodeSet.has(link.target))
    .map((link, index) => ({
      id: `${link.source}-${link.target}-${index}`,
      source: link.source,
      target: link.target,
      type: "smoothstep",
      selectable: false,
      focusable: false,
      interactionWidth: 0,
      style: {
        stroke:
          link.attribution === "doco-auto"
            ? "rgba(115, 115, 115, 0.35)"
            : "rgba(80, 80, 80, 0.7)",
        strokeDasharray: link.attribution === "doco-auto" ? "4 4" : undefined,
      },
    }));

  return { flowNodes, flowEdges };
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
    case "rectangle":
    default:
      return "bpmnRectangle";
  }
}

function laneNodeId(laneId: string): string {
  return `lane:${laneId}`;
}

function topoSort(nodes: readonly BpmnNode[], links: readonly OverviewGraphLink[]): string[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const link of links) {
    if (!indegree.has(link.source) || !indegree.has(link.target)) continue;
    indegree.set(link.target, (indegree.get(link.target) ?? 0) + 1);
    (adj.get(link.source) as string[]).push(link.target);
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree.entries()) if (deg === 0) queue.push(id);
  // Stable order: sort by created_at within zero-indegree set.
  const tsById = new Map<string, number>(
    nodes.map((n) => [n.id, n.created_at ? Date.parse(n.created_at) : 0]),
  );
  queue.sort((a, b) => (tsById.get(a) ?? 0) - (tsById.get(b) ?? 0));
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    order.push(current);
    const next = adj.get(current) ?? [];
    for (const target of next) {
      const deg = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, deg);
      if (deg === 0) queue.push(target);
    }
  }
  // Append cycle survivors (if any) at the end so we still place them.
  if (order.length < nodes.length) {
    const placed = new Set(order);
    for (const n of nodes) if (!placed.has(n.id)) order.push(n.id);
  }
  return order;
}

// ─── Custom node components ────────────────────────────────────────

interface BpmnNodeData {
  node: BpmnNode;
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
  return (
    <div
      className="pointer-events-none flex items-center justify-center px-2 text-center text-[10px] font-medium leading-tight"
      style={{ width: "100%", height: "100%", color: "#1f1f1f" }}
      title={node.name ?? ""}
    >
      <span className="line-clamp-3">{node.name ?? <em>(unnamed)</em>}</span>
    </div>
  );
}

function commonHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </>
  );
}

function BpmnRectangleNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
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
      <TypeBadge node={data.node} />
      <ShapeLabel node={data.node} />
      {commonHandles()}
    </div>
  );
}

function BpmnRoundedNode({ data }: { data: BpmnNodeData }) {
  const stroke = lifecycleColor(data.node.lifecycle);
  return (
    <div
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
      <TypeBadge node={data.node} />
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
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
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
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
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
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg
        viewBox="0 0 140 60"
        preserveAspectRatio="none"
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
      <ShapeLabel node={data.node} />
      {commonHandles()}
    </div>
  );
}

function TypeBadge({ node, circular = false }: { node: BpmnNode; circular?: boolean }) {
  const color = nodeTypeColor(node.entity_type);
  return (
    <span
      style={{
        position: "absolute",
        top: circular ? -8 : -7,
        left: circular ? "50%" : 6,
        transform: circular ? "translateX(-50%)" : undefined,
        background: color,
        color: "#fff",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
        padding: "2px 5px",
        borderRadius: 3,
        letterSpacing: 0.3,
        pointerEvents: "none",
        textTransform: "uppercase",
      }}
    >
      {labelForType(node.entity_type)}
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
