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
  type MiniMapNodeProps,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LifecycleBadge, ReferenceNumberBadge } from "~/components/neuron-badges";
import { StandardControls, StandardMiniMap } from "~/components/perspective-canvas-overlays";
import { lifecycleColor } from "~/lib/neuron-colors";
import type { OrgTreeNode } from "~/lib/org-tree-perspective.server";
import { type ReferenceCandidate, usePerspectiveReferences } from "~/lib/perspective-references";
import "@xyflow/react/dist/style.css";

interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

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
  // Reference number from the shared `usePerspectiveReferences`
  // hook (same hook Graph + BPMN use). Viewport-driven, so the
  // number can shift as the user pans/zooms — same contract as
  // the other perspectives.
  referenceNumber?: number;
}

// Tree-layout entry point. Returns positioned React Flow nodes + edges
// in one pass so the component can pass them straight into <ReactFlow>.
// Reference numbering is layered on top by `usePerspectiveReferences`
// in OrgTreeInner — not threaded through here.
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

  const rfNodes: Node<OrgTreeNodeData>[] = rawNodes
    .filter((n) => positions.has(n.id))
    .map((n) => ({
      id: n.id,
      type: "orgTreeNode",
      position: positions.get(n.id) as { x: number; y: number },
      // initialWidth/Height (NOT style.width/height) seed React Flow's
      // `node.measured.{width,height}` before its ResizeObserver
      // settles. The MiniMap reads `measured` to render silhouettes —
      // without these the MiniMap stays blank because it can't size
      // the per-node rect. Mirrors the Graph perspective.
      initialWidth: NODE_W,
      initialHeight: NODE_H,
      data: {
        org: n,
        isCenter: n.id === centerId,
      },
      draggable: false,
      selectable: false,
      style: { width: NODE_W, height: NODE_H },
    }));

  // Muted, low-contrast connector — matches the visual weight of the
  // other perspectives and stays out of the way of the cards.
  const edgeStroke = "var(--color-muted-foreground)";
  const rfEdges: Edge[] = rawNodes
    .filter((n) => n.reports_to && byId.has(n.reports_to) && n.reports_to !== n.id)
    .map((n) => ({
      id: `${n.id}->${n.reports_to}`,
      source: n.reports_to as string,
      target: n.id,
      type: "smoothstep",
      animated: false,
      style: { stroke: edgeStroke, strokeWidth: 1.5, opacity: 0.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeStroke },
    }));

  return { nodes: rfNodes, edges: rfEdges };
}

// Custom React Flow node — the principal card.
//
// Visual hierarchy: the Principal's `name` (the identity slug — the
// thing that makes "alex" *that* alex, not "another alex") is the
// headline. An optional one-line description (from `summary`) sits
// beneath. The Person/Agent kind shows as a bare emoji icon in the
// bottom corner (👤 / 🤖) next to the lifecycle badge — inferred
// from body_md prose (the slim-down moved the kind out of a
// structured field). When the prose is silent the icon is omitted.
//
// Sized via inline style (Tailwind's JIT can't see template-literal
// class names).
function OrgTreeCard({ data }: NodeProps<Node<OrgTreeNodeData>>) {
  const { org, isCenter, referenceNumber } = data;
  const kindIcon = org.type === "agent" ? "🤖" : org.type === "person" ? "👤" : null;
  const kindLabel = org.type === "agent" ? "agent" : org.type === "person" ? "person" : null;
  return (
    <div
      className={`relative flex flex-col justify-between rounded-md border bg-white px-3 py-2 shadow-sm transition ${
        isCenter ? "border-2 border-foreground" : "border-border"
      }`}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <ReferenceNumberBadge referenceNumber={referenceNumber} referenceLabel={org.name} />
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }}
      />
      <div className="min-w-0">
        <div className="truncate text-base font-semibold leading-tight text-foreground">
          {org.name}
        </div>
        {org.description ? (
          <div className="truncate text-[11px] leading-snug text-muted-foreground">
            {org.description}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        {kindIcon ? (
          <span
            aria-label={`Principal type: ${kindLabel}`}
            title={`Principal type: ${kindLabel}`}
            className="select-none text-sm leading-none"
          >
            {kindIcon}
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

// MiniMap node component — mirrors each Principal card as a small
// rounded rectangle filled with its lifecycle color, with a thicker
// stroke on the focal node. Same shape contract Graph and BPMN use,
// so the org-tree minimap reads as a true silhouette rather than the
// empty viewport box React Flow falls back to when no nodeComponent
// is passed.
function makeOrgTreeMiniMapNode(
  nodeById: Map<string, OrgTreeNode>,
  centerId: string | null,
): ComponentType<MiniMapNodeProps> {
  return function OrgTreeMiniMapNode({
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
    const principal = nodeById.get(id);
    if (!principal) return null;
    const fill = lifecycleColor(principal.lifecycle);
    const stroke = strokeColor ?? "rgba(0,0,0,0.5)";
    const sw = (strokeWidth ?? 1) * (id === centerId ? 2 : 1);
    const radius = Math.min(width, height) / 3;
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
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
          style={{ vectorEffect: "non-scaling-stroke" }}
        />
      </g>
    );
  };
}

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

  const { nodes: rawRfNodes, edges: rfEdges } = useMemo(
    () => layoutOrgTree(filtered, centerId ?? null),
    [filtered, centerId],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();

  // Viewport + size tracked the same way Graph/BPMN do it: ResizeObserver
  // on the container for size, React Flow's `onMove` for the viewport.
  // Both feed `usePerspectiveReferences`, which mirrors the Graph's
  // viewport-driven numbering (re-rank when the user pans/zooms, hide
  // when zoom < REFERENCE_ZOOM_THRESHOLD, cap at MAX_GRAPH_REFERENCES).
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const updateViewport = useCallback((next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () =>
      setSize({ width: Math.max(1, el.clientWidth), height: Math.max(1, el.clientHeight) });
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Per-Principal lookup used by the minimap to color each node by
  // its lifecycle. Rebuilt only when filtering changes.
  const principalById = useMemo(() => {
    const map = new Map<string, OrgTreeNode>();
    for (const n of filtered) map.set(n.id, n);
    return map;
  }, [filtered]);
  const MiniMapNode = useMemo(
    () => makeOrgTreeMiniMapNode(principalById, centerId ?? null),
    [principalById, centerId],
  );

  // Candidates for the shared numbering hook. Canvas-space positions
  // (already computed by `layoutOrgTree`) + node dimensions in canvas
  // units; the hook handles screen projection + sort + cap.
  const referenceCandidates = useMemo<ReferenceCandidate[]>(
    () =>
      rawRfNodes.map((n) => ({
        id: n.id,
        entity_type: "principal",
        label: n.data.org.name,
        lifecycle: n.data.org.lifecycle,
        href: n.data.org.href ?? null,
        position: { x: n.position.x, y: n.position.y },
        width: NODE_W,
        height: NODE_H,
      })),
    [rawRfNodes],
  );
  const { numberById: referenceNumberByNodeId } = usePerspectiveReferences({
    source: "org-tree",
    viewport,
    size,
    candidates: referenceCandidates,
  });

  // Splice the reference numbers into the node data without rebuilding
  // the rest of the layout. Kept separate from `layoutOrgTree` so the
  // tree-shape work doesn't re-run on every pan/zoom.
  const rfNodes = useMemo<Node<OrgTreeNodeData>[]>(
    () =>
      rawRfNodes.map((n) => {
        const referenceNumber = referenceNumberByNodeId.get(n.id);
        if (!referenceNumber) return n;
        return { ...n, data: { ...n.data, referenceNumber } };
      }),
    [rawRfNodes, referenceNumberByNodeId],
  );

  // Stable signature of the layout's *shape* — node ids + reports_to
  // edges, in deterministic order. The dashboard re-fetches Principals
  // every 5s for the live feed (ADR-089), so `nodes`/`filtered` get
  // fresh array identity on every poll even when no Principal actually
  // changed. Gating fitView on identity made the canvas zoom-reset on
  // every poll; gating on this signature only fires when topology
  // actually changes (added/removed/rewired Principal, lifecycle filter
  // toggle).
  const layoutSignature = useMemo(
    () =>
      filtered
        .map((n) => `${n.id}>${n.reports_to ?? ""}`)
        .sort()
        .join("|"),
    [filtered],
  );

  // Fit-to-view whenever the layout actually changes shape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutSignature is the intentional trigger.
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
  }, [flow, layoutSignature]);

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
        onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <StandardControls fitViewOptions={{ padding: 0.2 }} />
        <StandardMiniMap nodeComponent={MiniMapNode} />
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
