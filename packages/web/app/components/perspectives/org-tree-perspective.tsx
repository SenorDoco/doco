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
import { StandardControls, StandardMiniMap } from "~/components/perspective-canvas-overlays";
import { lifecycleColor } from "~/lib/neuron-colors";
import { ORG_TREE_NODE_H, ORG_TREE_NODE_W, layoutOrgTree } from "~/lib/org-tree-layout";
import type { OrgTreeNode } from "~/lib/org-tree-perspective.server";
import { type ReferenceCandidate, usePerspectiveReferences } from "~/lib/perspective-references";
import "@xyflow/react/dist/style.css";

interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

interface OrgTreePerspectiveProps {
  nodes: OrgTreeNode[];
  visibleLifecycles?: Set<string> | null;
  centerId?: string | null;
  initialFocusId?: string | null;
  onCenterChange?: (id: string) => void;
  onNeuronClick?: (node: OrgTreeNode) => void;
}

interface OrgTreeNodeData extends Record<string, unknown> {
  org: OrgTreeNode;
  isCenter: boolean;
}

// Custom React Flow node — the principal card.
//
// Visual hierarchy: icon, Principal name, and a compact role label
// derived from the first body_md line. Lifecycle and reference badges
// stay out of the card so the org chart reads like an org chart.
//
// Sized via inline style (Tailwind's JIT can't see template-literal
// class names).
function OrgTreeCard({ data }: NodeProps<Node<OrgTreeNodeData>>) {
  const { org, isCenter } = data;
  const kindIcon = org.type === "agent" ? "🤖" : org.type === "person" ? "👤" : null;
  const kindLabel = org.type === "agent" ? "agent" : org.type === "person" ? "person" : null;
  return (
    <div
      className={`relative flex flex-col justify-between rounded-md border bg-white px-3 py-2 shadow-sm transition ${
        isCenter ? "border-2 border-foreground" : "border-border"
      }`}
      style={{ width: ORG_TREE_NODE_W, height: ORG_TREE_NODE_H }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }}
      />
      <div className="flex min-w-0 items-center gap-2">
        {kindIcon ? (
          <span
            aria-label={`Principal type: ${kindLabel}`}
            title={`Principal type: ${kindLabel}`}
            className="shrink-0 select-none text-base leading-none"
          >
            {kindIcon}
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight text-foreground">
            {org.name}
          </div>
          {org.role ? (
            <div className="truncate text-[11px] leading-snug text-muted-foreground">
              {org.role}
            </div>
          ) : null}
        </div>
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
  initialFocusId,
  onCenterChange,
  onNeuronClick,
}: OrgTreePerspectiveProps) {
  const filtered = useMemo(() => {
    if (!visibleLifecycles) return nodes;
    return nodes.filter((n) => visibleLifecycles.has(n.lifecycle));
  }, [nodes, visibleLifecycles]);

  const { nodes: rawRfNodes, edges: rfEdges } = useMemo(() => {
    const layout = layoutOrgTree(filtered, centerId ?? null);
    const nodes: Node<OrgTreeNodeData>[] = layout.nodes.map((n) => ({
      id: n.id,
      type: "orgTreeNode",
      position: n.position,
      // initialWidth/Height (NOT style.width/height) seed React Flow's
      // `node.measured.{width,height}` before its ResizeObserver
      // settles. The MiniMap reads `measured` to render silhouettes —
      // without these the MiniMap stays blank because it can't size
      // the per-node rect. Mirrors the Graph perspective.
      initialWidth: ORG_TREE_NODE_W,
      initialHeight: ORG_TREE_NODE_H,
      data: {
        org: n.org,
        isCenter: n.isCenter,
      },
      draggable: false,
      selectable: false,
      style: { width: ORG_TREE_NODE_W, height: ORG_TREE_NODE_H },
    }));
    // Muted, low-contrast connector — matches the visual weight of
    // the other perspectives and stays out of the way of the cards.
    const edgeStroke = "var(--color-muted-foreground)";
    const edges: Edge[] = layout.edges.map((e) => ({
      ...e,
      type: "smoothstep",
      pathOptions: { borderRadius: 20, offset: 20 },
      animated: false,
      style: { stroke: edgeStroke, strokeWidth: 1.5, opacity: 0.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeStroke },
    }));
    return { nodes, edges };
  }, [filtered, centerId]);

  const containerRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  const initialFocusAppliedRef = useRef<string | null>(null);

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
        width: ORG_TREE_NODE_W,
        height: ORG_TREE_NODE_H,
      })),
    [rawRfNodes],
  );
  usePerspectiveReferences({
    source: "org-tree",
    viewport,
    size,
    candidates: referenceCandidates,
  });

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
  const initialFocusFlowNodeId = useMemo(() => {
    if (!initialFocusId) return null;
    return rawRfNodes.some((node) => node.id === initialFocusId) ? initialFocusId : null;
  }, [initialFocusId, rawRfNodes]);

  useEffect(() => {
    if (!initialFocusFlowNodeId) return;
    if (initialFocusAppliedRef.current === initialFocusFlowNodeId) return;
    const frame = requestAnimationFrame(() => {
      try {
        flow.fitView({
          nodes: [{ id: initialFocusFlowNodeId }],
          padding: 0,
          minZoom: 1,
          maxZoom: 1,
          duration: 0,
        });
        initialFocusAppliedRef.current = initialFocusFlowNodeId;
      } catch {
        // React Flow may not be ready on the very first paint.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, initialFocusFlowNodeId]);

  // Fit-to-view whenever the layout actually changes shape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutSignature is the intentional trigger.
  useEffect(() => {
    if (initialFocusId) return;
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
        No org yet, just vibes.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <ReactFlow
        nodes={rawRfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
        onlyRenderVisibleElements
        fitView={!initialFocusFlowNodeId}
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
