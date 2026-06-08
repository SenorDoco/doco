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
// (pan / zoom / fullscreen come for free). Edges are
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
import { StandardControls } from "~/components/perspective-canvas-overlays";
import { focalEdgeWidth } from "~/lib/graph-depth";
import { type LifecycleCounts, lifecycleColor } from "~/lib/node-colors";
import { ORG_TREE_NODE_H, ORG_TREE_NODE_W, layoutOrgTree } from "~/lib/org-tree-layout";
import type { OrgTreeNode } from "~/lib/org-tree-perspective.server";
import { perspectiveCountLabel, visibleLifecycleTotal } from "~/lib/perspective-count";
import {
  type ReferenceCandidate,
  referencesFromCandidates,
  usePublishedReferences,
} from "~/lib/perspective-references";
import "@xyflow/react/dist/style.css";

interface OrgTreePerspectiveProps {
  nodes: OrgTreeNode[];
  /** TRUE per-lifecycle totals of principals — the overlay sums the stages the
   *  lifecycle filter shows, so the count tracks the rendered tree. */
  totalByLifecycle?: LifecycleCounts;
  visibleLifecycles?: Set<string> | null;
  centerId?: string | null;
  initialFocusId?: string | null;
  onCenterChange?: (id: string | null) => void;
  onPaneClick?: () => void;
  onNodeClick?: (node: OrgTreeNode) => void;
}

interface OrgTreeNodeData extends Record<string, unknown> {
  org: OrgTreeNode;
  isCenter: boolean;
}

// Wide org charts (many siblings near the top of the chain) spread far
// past the viewport. ReactFlow clamps the reachable zoom at `minZoom`, so
// the floor has to sit low enough for `fitView` to pull the whole tree on
// screen instead of cropping the outermost branches.
export const ORG_TREE_MIN_ZOOM = 0.05;
export const ORG_TREE_MAX_ZOOM = 1.5;

// Custom React Flow node — the principal card.
//
// Visual hierarchy: icon and Principal name. Lifecycle and reference badges
// stay out of the card so the org chart reads like an org chart.
//
// Sized via inline style (Tailwind's JIT can't see template-literal
// class names).
export function OrgTreeCard({ data }: NodeProps<Node<OrgTreeNodeData>>) {
  const { org, isCenter } = data;
  const kindIcon =
    org.type === "agent"
      ? "🤖"
      : org.type === "person"
        ? "👤"
        : org.type === "vacant"
          ? "🪑"
          : null;
  const kindLabel =
    org.type === "agent"
      ? "agent"
      : org.type === "person"
        ? "person"
        : org.type === "vacant"
          ? "vacant"
          : null;
  return (
    <div
      className={`relative flex cursor-pointer flex-col justify-between rounded-md border bg-white px-3 py-2 shadow-sm transition ${
        isCenter ? "border-4 border-foreground" : "border-border"
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
          <div className="break-words text-sm font-semibold leading-tight text-foreground">
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

function OrgTreeInner({
  nodes,
  totalByLifecycle,
  visibleLifecycles,
  centerId,
  initialFocusId,
  onCenterChange,
  onPaneClick,
  onNodeClick,
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
      // settles, so the initial fitView computes against real sizes
      // instead of zeros. Mirrors the Graph perspective.
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
      pathOptions: { borderRadius: 0, offset: 20 },
      animated: false,
      style: {
        stroke: edgeStroke,
        strokeWidth: focalEdgeWidth(e.source, e.target, centerId, 1.5),
        // Dotted-line (matrix) reporting renders dashed and fainter so
        // it reads as secondary to the solid primary `reports_to` tree.
        opacity: e.dotted ? 0.4 : 0.6,
        ...(e.dotted ? { strokeDasharray: "5 4" } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeStroke },
    }));
    return { nodes, edges };
  }, [filtered, centerId]);

  const flow = useReactFlow();
  const initialFocusAppliedRef = useRef<string | null>(null);

  // Candidates for the shared numbering. Canvas-space positions (already
  // computed by `layoutOrgTree`) + node dimensions in canvas units; the
  // numbering is assigned in reading order over those positions, once per
  // rendered set — never on pan/zoom. The org chart shows no #N badges on
  // its cards, so this only feeds the sidebar References list.
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
  const references = useMemo(
    () => referencesFromCandidates(referenceCandidates),
    [referenceCandidates],
  );
  usePublishedReferences("org-tree", references);

  // Stable signature of the layout's *shape* — node ids + reports_to
  // edges, in deterministic order. A revalidation (the viewer's own edit,
  // or clicking "Refresh") hands `nodes`/`filtered` fresh array identity
  // even when no Principal actually changed. Gating fitView on identity
  // would zoom-reset the canvas on any such reload; gating on this
  // signature only fires when topology actually changes (added/removed/
  // rewired Principal, lifecycle filter toggle).
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
      onNodeClick?.(node.data.org);
    },
    [onCenterChange, onNodeClick],
  );

  if (filtered.length === 0) {
    return (
      <div className="flex h-full min-h-[400px] items-center justify-center text-sm text-muted-foreground">
        No org yet, just vibes.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {/* Dataset count overlay — honest about truncation AND the lifecycle
          filter. Sums only the principals whose lifecycle the filter shows
          against the rendered slice, so the count tracks the tree. */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded bg-card/80 px-2 py-1 text-xs tabular-nums text-muted-foreground backdrop-blur-sm">
        {perspectiveCountLabel(
          {
            loaded: filtered.length,
            total: totalByLifecycle
              ? visibleLifecycleTotal(totalByLifecycle, visibleLifecycles)
              : filtered.length,
          },
          "principal",
        )}
      </div>
      <ReactFlow
        nodes={rawRfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={onPaneClick}
        onlyRenderVisibleElements
        fitView={!initialFocusFlowNodeId}
        fitViewOptions={{ padding: 0.2 }}
        minZoom={ORG_TREE_MIN_ZOOM}
        maxZoom={ORG_TREE_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <StandardControls fitViewOptions={{ padding: 0.2 }} />
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
