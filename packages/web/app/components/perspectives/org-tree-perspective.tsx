// Org-tree perspective — top-down reporting hierarchy.
//
// Layout: a Reingold-Tilford-like tree. For each subtree we measure
// its rendered width, then place the parent centered above the band
// occupied by its children. Multiple roots (more than one top-of-
// chain Principal) lay out side-by-side. Cycles can't be formed
// through the API today, but a depth guard keeps a hand-imported
// cycle from infinite-looping the layout.
//
// Rendering uses @xyflow/react for parity with the other perspectives
// (pan / zoom / minimap / fullscreen come for free). Edges are
// smoothstep so reporting lines render as clean orthogonal connectors,
// not the curved force-directed paths the overview graph uses.

import {
  Background,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { LifecycleBadge } from "~/components/neuron-badges";
import { StandardControls, StandardMiniMap } from "~/components/perspective-canvas-overlays";
import {
  computeDepthFromCenter,
  hasFocalNode,
  opacityForDepth,
  opacityForEdge,
} from "~/lib/graph-depth";
import type { OrgTreeNode } from "~/lib/org-tree-perspective.server";
import "@xyflow/react/dist/style.css";

const NODE_W = 240;
const NODE_H = 108;
const H_GAP = 40;
const V_GAP = 60;
const MAX_DEPTH = 50;

interface OrgTreePerspectiveProps {
  nodes: OrgTreeNode[];
  visibleLifecycles?: Set<string> | null;
  centerId?: string | null;
  onCenterChange?: (id: string) => void;
  onNeuronClick?: (node: OrgTreeNode) => void;
}

interface OrgTreeNodeData extends Record<string, unknown> {
  org: OrgTreeNode;
  isCenter: boolean;
  // Depth-based opacity from the focal node (matches BPMN + Graph).
  // 1 when no focal node is set; otherwise: focal + 1st degree = 1,
  // 2nd = 0.75, 3rd = 0.5, 4+ / unreachable = 0.25.
  opacity: number;
}

// Tree-layout entry point. Returns positioned React Flow nodes + edges
// in one pass so the component can pass them straight into <ReactFlow>.
function layoutOrgTree(
  rawNodes: OrgTreeNode[],
  centerId: string | null,
): { nodes: Node<OrgTreeNodeData>[]; edges: Edge[] } {
  if (rawNodes.length === 0) return { nodes: [], edges: [] };

  const byId = new Map<string, OrgTreeNode>();
  for (const n of rawNodes) byId.set(n.id, n);

  // manager_id → [report_ids]. Stable child order = creation order
  // (rawNodes is sorted by created_at server-side).
  const childrenOf = new Map<string, string[]>();
  for (const n of rawNodes) {
    if (n.reports_to && byId.has(n.reports_to) && n.reports_to !== n.id) {
      const list = childrenOf.get(n.reports_to) ?? [];
      list.push(n.id);
      childrenOf.set(n.reports_to, list);
    }
  }

  // Roots = Principals with no resolvable manager. Includes orphans
  // whose reports_to points outside the active set (e.g. a retired
  // manager) — they render as their own root rather than disappearing.
  const roots = rawNodes
    .filter((n) => !n.reports_to || !byId.has(n.reports_to) || n.reports_to === n.id)
    .map((n) => n.id);

  // Subtree widths, memoized + cycle-safe.
  const subtreeWidth = new Map<string, number>();
  const measureStack = new Set<string>();
  function measure(id: string): number {
    if (subtreeWidth.has(id)) return subtreeWidth.get(id) as number;
    if (measureStack.has(id)) {
      // Cycle — treat as leaf to break the recursion.
      subtreeWidth.set(id, NODE_W);
      return NODE_W;
    }
    measureStack.add(id);
    const children = childrenOf.get(id) ?? [];
    let width: number;
    if (children.length === 0) {
      width = NODE_W;
    } else {
      const total = children.reduce((sum, c, i) => sum + measure(c) + (i > 0 ? H_GAP : 0), 0);
      width = Math.max(NODE_W, total);
    }
    measureStack.delete(id);
    subtreeWidth.set(id, width);
    return width;
  }

  const positions = new Map<string, { x: number; y: number }>();
  const placedStack = new Set<string>();
  function place(id: string, leftX: number, depth: number): void {
    if (depth > MAX_DEPTH || placedStack.has(id)) return;
    placedStack.add(id);
    const width = subtreeWidth.get(id) ?? NODE_W;
    const x = leftX + width / 2 - NODE_W / 2;
    const y = depth * (NODE_H + V_GAP);
    positions.set(id, { x, y });
    let childX = leftX;
    for (const c of childrenOf.get(id) ?? []) {
      place(c, childX, depth + 1);
      childX += (subtreeWidth.get(c) ?? NODE_W) + H_GAP;
    }
  }

  let rootX = 0;
  for (const rootId of roots) {
    place(rootId, rootX, 0);
    rootX += (subtreeWidth.get(rootId) ?? NODE_W) + H_GAP;
  }

  // Depth-aware opacity — same contract every perspective uses.
  // BFS over the reports_to relationships (undirected, like the other
  // perspectives' graph-depth helper). Then opacityForDepth picks the
  // ramp value per node, opacityForEdge per edge.
  const orgLinks = rawNodes
    .filter((n) => n.reports_to && byId.has(n.reports_to) && n.reports_to !== n.id)
    .map((n) => ({ source: n.reports_to as string, target: n.id }));
  const depthByNode = computeDepthFromCenter(rawNodes, orgLinks, centerId);
  const focalActive = hasFocalNode(centerId, rawNodes);

  const rfNodes: Node<OrgTreeNodeData>[] = rawNodes
    .filter((n) => positions.has(n.id))
    .map((n) => ({
      id: n.id,
      type: "orgTreeNode",
      position: positions.get(n.id) as { x: number; y: number },
      data: {
        org: n,
        isCenter: n.id === centerId,
        opacity: focalActive ? opacityForDepth(depthByNode.get(n.id)) : 1,
      },
      draggable: false,
      selectable: false,
    }));

  // Muted, low-contrast connector — matches the visual weight of the
  // other perspectives and stays out of the way of the cards.
  const edgeStroke = "var(--color-muted-foreground)";
  const rfEdges: Edge[] = rawNodes
    .filter((n) => n.reports_to && byId.has(n.reports_to) && n.reports_to !== n.id)
    .map((n) => {
      const edgeOpacity = focalActive
        ? opacityForEdge(depthByNode.get(n.reports_to as string), depthByNode.get(n.id))
        : 0.6;
      return {
        id: `${n.id}->${n.reports_to}`,
        source: n.reports_to as string,
        target: n.id,
        type: "smoothstep",
        animated: false,
        style: { stroke: edgeStroke, strokeWidth: 1.5, opacity: edgeOpacity },
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeStroke },
      };
    });

  return { nodes: rfNodes, edges: rfEdges };
}

// Custom React Flow node — the principal card.
//
// Visual hierarchy: the Principal's `name` (the identity slug — the
// thing that makes "alex" *that* alex, not "another alex") is the
// big headline. The `display_name` sits beneath as the role title
// ("CEO", "Head of Engineering"). The Person/Agent kind shows as a
// text pill in the bottom corner next to the lifecycle badge,
// replacing the slug-pill we used to render there — the slug is now
// the headline so a redundant copy below would be wasted ink.
//
// Sized via inline style (Tailwind's JIT can't see template-literal
// class names).
function OrgTreeCard({ data }: NodeProps<Node<OrgTreeNodeData>>) {
  const { org, isCenter, opacity } = data;
  const kindLabel = org.type === "agent" ? "Agent" : org.type === "person" ? "Person" : null;
  return (
    <div
      className={`flex flex-col justify-between rounded-md border bg-card px-3 py-2 shadow-sm transition ${
        isCenter ? "border-2 border-foreground" : "border-border"
      }`}
      style={{ width: NODE_W, height: NODE_H, opacity }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }}
      />
      <div className="min-w-0">
        <div className="truncate text-base font-semibold leading-tight text-foreground">
          {org.name}
        </div>
        <div className="truncate font-mono text-xs leading-snug text-muted-foreground">
          {org.display_name}
        </div>
        {org.description ? (
          <div className="truncate text-[11px] leading-snug text-muted-foreground">
            {org.description}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        {kindLabel ? (
          <span
            className="select-none rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-secondary-foreground"
            title={`Principal type: ${kindLabel.toLowerCase()}`}
          >
            {kindLabel}
          </span>
        ) : null}
        <LifecycleBadge lifecycle={org.lifecycle} />
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }}
      />
    </div>
  );
}

const nodeTypes = { orgTreeNode: OrgTreeCard };

function OrgTreeInner({
  nodes,
  visibleLifecycles,
  centerId,
  onCenterChange,
  onNeuronClick,
}: OrgTreePerspectiveProps) {
  const filtered = useMemo(() => {
    if (!visibleLifecycles) return nodes;
    return nodes.filter((n) => visibleLifecycles.has(n.lifecycle));
  }, [nodes, visibleLifecycles]);

  const { nodes: rfNodes, edges: rfEdges } = useMemo(
    () => layoutOrgTree(filtered, centerId ?? null),
    [filtered, centerId],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();

  // Fit-to-view whenever the layout changes shape. The effect body
  // doesn't reference rfNodes/rfEdges directly, but we DO want it to
  // re-run when those change — otherwise the viewport stays zoomed
  // to whatever the initial paint showed even as Principals are
  // added or rewired.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rfNodes/rfEdges are intentional triggers.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        flow.fitView({ padding: 0.2, duration: 250 });
      } catch {
        // React Flow may not be ready on the very first paint — silent
        // skip; the next layout effect will retry.
      }
    });
    return () => cancelAnimationFrame(id);
  }, [flow, rfNodes, rfEdges]);

  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node<OrgTreeNodeData>) => {
      onCenterChange?.(node.id);
      onNeuronClick?.(node.data.org);
    },
    [onCenterChange, onNeuronClick],
  );

  if (filtered.length === 0) {
    return (
      <div className="flex h-full min-h-[400px] items-center justify-center text-sm text-muted-foreground">
        No Principals to render. Capture one via
        <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">POST /api/principals.json</code>
        to get started.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <StandardControls fitViewOptions={{ padding: 0.2 }} />
        <StandardMiniMap />
      </ReactFlow>
      {/* Fullscreen toggle lives on PerspectiveFrame. */}
    </div>
  );
}

export function OrgTreePerspective(props: OrgTreePerspectiveProps) {
  return (
    <ReactFlowProvider>
      <OrgTreeInner {...props} />
    </ReactFlowProvider>
  );
}
