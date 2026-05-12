// Entity-detail graph view (ADR-076).
// Renders a force-directed map of the focal node's most-relevant neighborhood.
// react-force-graph-2d is loaded via dynamic import — it touches `window` and
// canvas APIs, so it can't run during SSR.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

export interface GraphNode {
  id: string;
  node_type: string;
  summary: string;
  /** Whether this is the focal node (centered, highlighted). */
  is_center?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
  edge_type: string;
}

interface EntityGraphProps {
  centerId: string;
  /** All nodes to render, including the focal one. */
  nodes: GraphNode[];
  /** Edges between included nodes (does not include phantom edges to nodes outside the set). */
  links: GraphLink[];
  /** Function to compute the URL for a clicked node. Falls back to /e/<type>/<id>. */
  hrefFor?: (id: string, nodeType: string) => string;
}

/**
 * Color palette per node_type. Tailwind brand colors stay consistent with
 * the project's olive-on-light theme; brighter fills here so the graph
 * reads against the neutral page background.
 */
const TYPE_COLOR: Record<string, string> = {
  doco: "#525252",
  principal: "#3b82f6",
  organization: "#6366f1",
  intent: "#16a34a",
  idea: "#ec4899",
  rule: "#dc2626",
  decision: "#f97316",
  action: "#9333ea",
  reasoning: "#eab308",
  evaluation: "#14b8a6",
  reference: "#a16207",
  scope: "#84cc16",
};
const FALLBACK_COLOR = "#525252";

export function EntityGraph({ centerId, nodes, links, hrefFor }: EntityGraphProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<unknown>(null);

  // Filter UI: a Set of *hidden* node types. Default empty (all visible).
  const allTypes = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) set.add(n.node_type);
    return Array.from(set).sort();
  }, [nodes]);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  // Filtered graph data.
  const visibleData = useMemo(() => {
    const visible = nodes.filter(
      (n) => n.id === centerId || !hiddenTypes.has(n.node_type),
    );
    const visibleIds = new Set(visible.map((n) => n.id));
    const visibleLinks = links.filter(
      (l) =>
        visibleIds.has(typeof l.source === "string" ? l.source : (l.source as { id: string }).id) &&
        visibleIds.has(typeof l.target === "string" ? l.target : (l.target as { id: string }).id),
    );
    return { nodes: visible, links: visibleLinks };
  }, [nodes, links, hiddenTypes, centerId]);

  // Lazy-load the canvas-based force graph (uses `window`, can't SSR).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [ForceGraph, setForceGraph] = useState<any>(null);
  useEffect(() => {
    let canceled = false;
    import("react-force-graph-2d").then((mod) => {
      if (!canceled) setForceGraph(() => mod.default);
    });
    return () => {
      canceled = true;
    };
  }, []);

  // Track container size — react-force-graph needs explicit width/height.
  const [size, setSize] = useState({ w: 480, h: 480 });
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSize({ w: Math.floor(width), h: Math.floor(height) });
        }
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {/* Type filter checkboxes */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="text-muted-foreground">Show:</span>
        {allTypes.map((t) => {
          const visible = !hiddenTypes.has(t);
          const color = TYPE_COLOR[t] ?? FALLBACK_COLOR;
          return (
            <label
              key={t}
              className="inline-flex items-center gap-1 cursor-pointer select-none"
              title={t}
            >
              <input
                type="checkbox"
                checked={visible}
                onChange={() => {
                  setHiddenTypes((prev) => {
                    const next = new Set(prev);
                    if (visible) next.add(t);
                    else next.delete(t);
                    return next;
                  });
                }}
                className="h-3 w-3"
              />
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              {t}
            </label>
          );
        })}
      </div>

      {/* The graph itself */}
      <div
        ref={containerRef}
        className="relative h-[480px] w-full rounded-md border border-border bg-input overflow-hidden"
      >
        {ForceGraph ? (
          <ForceGraph
            ref={fgRef}
            graphData={visibleData}
            width={size.w}
            height={size.h}
            backgroundColor="transparent"
            nodeId="id"
            nodeColor={(n: GraphNode) => TYPE_COLOR[n.node_type] ?? FALLBACK_COLOR}
            nodeRelSize={5}
            nodeVal={(n: GraphNode) => (n.is_center ? 12 : 4)}
            nodeLabel={(n: GraphNode) => `${n.node_type}: ${n.summary?.slice(0, 80) ?? n.id}`}
            linkColor={() => "rgba(112, 122, 35, 0.4)"}
            linkWidth={1}
            cooldownTicks={120}
            onNodeClick={(n: GraphNode) => {
              const href = hrefFor ? hrefFor(n.id, n.node_type) : `/e/${n.node_type}/${n.id}`;
              navigate(href);
            }}
            // Pin the center node at origin so the layout orbits it.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            d3VelocityDecay={0.4}
            enableNodeDrag={true}
            enableZoomInteraction={true}
            enablePanInteraction={true}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Loading graph…
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Drag to pan, scroll to zoom, click a node to navigate. Neighbors ranked by
        personalized PageRank from the focal node (ADR-076).
      </p>
    </div>
  );
}
