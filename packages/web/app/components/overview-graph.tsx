import { Handle, Position } from "@xyflow/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import {
  type GraphReferenceItem,
  clearGraphReferences,
  publishGraphReferences,
} from "~/lib/graph-references";
import { lifecycleColor } from "~/lib/neuron-colors";
import { useNewNodeIds } from "~/lib/use-new-neuron-ids";
import "@xyflow/react/dist/style.css";

export interface OverviewGraphNode {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href?: string | null;
  is_center?: boolean;
}

export interface OverviewGraphLink {
  source: string;
  target: string;
  synapse_type: string;
}

export interface OverviewGraphData {
  centerId: string;
  nodes: OverviewGraphNode[];
  links: OverviewGraphLink[];
  detailUrl: string | null;
}

export interface OverviewNodeDetail {
  id: string;
  entity_type: string;
  summary: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href?: string | null;
}

interface OverviewGraphProps extends OverviewGraphData {
  fillHeight?: boolean;
  search?: ReactNode;
  onNeuronClick?: (node: OverviewGraphNode) => void;
  /**
   * Externally-controlled lifecycle visibility set. When provided, the
   * graph uses it and DOES NOT render its own lifecycle filter row —
   * the caller is expected to render `<LifecycleFilter>` somewhere
   * else (typically the page bottom, shared across perspectives).
   * When omitted, the graph manages lifecycle state internally for
   * backwards compatibility (e.g. the org overview).
   */
  visibleLifecycles?: Set<string>;
}

interface Point {
  x: number;
  y: number;
}

interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

interface OverviewNodeData {
  node: OverviewGraphNode;
  detail?: OverviewNodeDetail;
  showDetail: boolean;
  referenceNumber?: number;
  isNew: boolean;
}

// Canonical Lifecycle (@doco/shared) — four stages, in progression
// order.
const LIFECYCLE_ORDER = ["drafted", "proposed", "active", "retired"];
const HIDDEN_LIFECYCLES_BY_DEFAULT = new Set(["retired"]);
const NODE_TYPE_ORDER = new Map(
  [
    "intent",
    "decision",
    "action",
    "rule",
    "guidance_primitive",
    "neuron_authoring_primitive",
    "log",
    "eval",
    "reference",
    "idea",
    "state",
  ].map((type, index) => [type, index]),
);

const OVERVIEW_NODE_WIDTH = 112;
const OVERVIEW_NODE_HEIGHT = 34;
const DETAIL_ZOOM = 0.95;
const MAX_DETAIL_FETCH = 80;
const GRAPH_MIN_ZOOM = 0.03;
const GRAPH_MAX_ZOOM = 2.5;
const GRAPH_FIT_VIEW_OPTIONS = { padding: 0.12, maxZoom: 1.2 };
const MAX_GRAPH_REFERENCES = 120;

function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replaceAll("_", " ");
}

function nodeLifecycle(node: { lifecycle: string | null }): string {
  return node.lifecycle ?? "active";
}

function layoutNodes(nodes: OverviewGraphNode[], centerId: string): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const center: Point = { x: 0, y: 0 };
  const others: OverviewGraphNode[] = [];
  let hasCenter = false;
  for (const node of nodes) {
    if (node.id === centerId) {
      positions.set(node.id, center);
      hasCenter = true;
    } else {
      others.push(node);
    }
  }

  if (others.length === 0) {
    if (!hasCenter) {
      // No focal node in the visible set — place the first node at origin
      // so the viewport has something to fit to.
      const first = nodes[0];
      if (first) positions.set(first.id, center);
    }
    return positions;
  }

  others.sort((a, b) => {
    const ai = NODE_TYPE_ORDER.get(a.entity_type) ?? 999;
    const bi = NODE_TYPE_ORDER.get(b.entity_type) ?? 999;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });

  const radius = Math.max(220, others.length * 18);
  const start = -Math.PI / 2;
  others.forEach((node, index) => {
    const angle = start + (Math.PI * 2 * index) / others.length;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });

  return positions;
}

function isVisibleInViewport(
  position: Point,
  viewport: FlowViewport,
  size: { width: number; height: number },
): boolean {
  const x = position.x * viewport.zoom + viewport.x;
  const y = position.y * viewport.zoom + viewport.y;
  return (
    x > -OVERVIEW_NODE_WIDTH * 2 &&
    y > -OVERVIEW_NODE_HEIGHT * 2 &&
    x < size.width + OVERVIEW_NODE_WIDTH * 2 &&
    y < size.height + OVERVIEW_NODE_HEIGHT * 2
  );
}

function screenPosition(position: Point, viewport: FlowViewport): Point {
  return {
    x: position.x * viewport.zoom + viewport.x,
    y: position.y * viewport.zoom + viewport.y,
  };
}

const HIDDEN_HANDLE_STYLE = {
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  background: "transparent",
  border: "none",
  pointerEvents: "none" as const,
  opacity: 0,
};

function OverviewFlowNode({ data }: { data: OverviewNodeData }) {
  const lifecycle = nodeLifecycle(data.node);
  const detail = data.detail;
  const title = detail?.name ?? data.node.name ?? detail?.summary ?? data.node.entity_type;
  const subtitle = detail?.summary ?? data.node.name ?? data.node.id;
  const showDetail = data.showDetail && Boolean(detail);

  return (
    <div className="relative h-full w-full overflow-visible">
      <div
        className={`overview-graph-node nodrag nopan flex h-full w-full items-center gap-1.5 overflow-hidden rounded-[4px] border bg-card px-2 text-left shadow-sm${data.isNew ? " doco-new-node-glow" : ""}`}
        data-graph-reference-number={data.referenceNumber ?? undefined}
        data-neuron-href={detail?.href ?? data.node.href ?? undefined}
        data-neuron-id={data.node.id}
        data-neuron-label={showDetail ? title : undefined}
        data-neuron-lifecycle={lifecycle}
        data-neuron-type={data.node.entity_type}
        data-overview-node-new={data.isNew ? "true" : undefined}
        style={{
          borderColor: data.node.is_center ? "var(--color-foreground)" : "var(--color-border)",
          borderLeft: `6px solid ${lifecycleColor(lifecycle)}`,
        }}
        title={showDetail ? title : `${data.node.entity_type} · ${lifecycle}`}
      >
        <Handle
          type="target"
          position={Position.Left}
          style={HIDDEN_HANDLE_STYLE}
          isConnectable={false}
        />
        <NeuronTypeIcon entityType={data.node.entity_type} className="!h-3.5 !w-3.5 shrink-0" />
        {showDetail ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold leading-none text-foreground">
            {title}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[9px] font-semibold uppercase leading-none text-muted-foreground">
            {data.node.entity_type}
          </span>
        )}
        {showDetail && title !== subtitle ? <span className="sr-only">{subtitle}</span> : null}
        <Handle
          type="source"
          position={Position.Right}
          style={HIDDEN_HANDLE_STYLE}
          isConnectable={false}
        />
      </div>
      {data.referenceNumber ? (
        <span
          aria-label={`Graph reference ${data.referenceNumber}: ${title}`}
          className="pointer-events-none absolute -left-2 -top-2 z-30 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
          title={`Graph reference ${data.referenceNumber}`}
        >
          {data.referenceNumber}
        </span>
      ) : null}
    </div>
  );
}

export function OverviewGraph({
  centerId,
  nodes,
  links,
  detailUrl,
  fillHeight = false,
  search,
  onNeuronClick,
  visibleLifecycles: externalVisibleLifecycles,
}: OverviewGraphProps) {
  const navigate = useNavigate();
  const graphRef = useRef<HTMLDivElement>(null);
  const graphReferenceIdRef = useRef(`overview-${Math.random().toString(36).slice(2)}`);
  const hasFitRef = useRef(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 });
  const [details, setDetails] = useState<Map<string, OverviewNodeDetail>>(() => new Map());
  const updateViewport = (next: FlowViewport) => {
    setViewport((prev) =>
      prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : next,
    );
  };

  const allLifecycles = useMemo(() => {
    const set = new Set<string>(["active"]);
    for (const node of nodes) set.add(nodeLifecycle(node));
    return Array.from(set).sort((a, b) => {
      const ai = LIFECYCLE_ORDER.indexOf(a);
      const bi = LIFECYCLE_ORDER.indexOf(b);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return a.localeCompare(b);
    });
  }, [nodes]);
  // When the caller passes a `visibleLifecycles` set, the graph is
  // "controlled" — external state wins and we don't render the
  // internal filter UI below. Otherwise we manage state locally
  // (legacy/uncontrolled).
  const controlledMode = externalVisibleLifecycles !== undefined;
  const [internalVisibleLifecycles, setVisibleLifecycles] = useState<Set<string>>(
    () =>
      new Set(allLifecycles.filter((lifecycle) => !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle))),
  );

  useEffect(() => {
    if (controlledMode) return;
    setVisibleLifecycles((prev) => {
      const next = new Set<string>();
      for (const lifecycle of allLifecycles) {
        if (prev.has(lifecycle) || !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle)) {
          next.add(lifecycle);
        }
      }
      return next;
    });
  }, [allLifecycles, controlledMode]);

  const visibleLifecycles = externalVisibleLifecycles ?? internalVisibleLifecycles;

  const visibleNodes = useMemo(
    () => nodes.filter((node) => visibleLifecycles.has(nodeLifecycle(node))),
    [nodes, visibleLifecycles],
  );

  // Diff against the full incoming `nodes` set, not `visibleNodes`, so
  // toggling a lifecycle filter back on doesn't glow nodes that have
  // been around the whole time.
  const allNodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const newNodeIds = useNewNodeIds(allNodeIds);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleLinks = useMemo(
    () => links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target)),
    [links, visibleIds],
  );
  const positions = useMemo(() => layoutNodes(visibleNodes, centerId), [visibleNodes, centerId]);
  const nodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  );

  // Dynamic import — React Flow touches the DOM during module init.
  const [Flow, setFlow] = useState<null | typeof import("@xyflow/react")>(null);
  useEffect(() => {
    let canceled = false;
    import("@xyflow/react").then((mod) => {
      if (!canceled) setFlow(mod);
    });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const update = () =>
      setSize({ width: Math.max(1, el.clientWidth), height: Math.max(1, el.clientHeight) });
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const detailIds = useMemo(() => {
    if (viewport.zoom < DETAIL_ZOOM) return [];
    return visibleNodes
      .filter((node) => {
        const position = positions.get(node.id);
        return position ? isVisibleInViewport(position, viewport, size) : false;
      })
      .slice(0, MAX_DETAIL_FETCH)
      .map((node) => node.id)
      .filter((id) => !details.has(id));
  }, [visibleNodes, positions, viewport, size, details]);

  const graphReferences = useMemo<GraphReferenceItem[]>(() => {
    if (viewport.zoom < DETAIL_ZOOM) return [];
    return visibleNodes
      .flatMap((node) => {
        const detail = details.get(node.id);
        const position = positions.get(node.id);
        if (!detail || !position || !isVisibleInViewport(position, viewport, size)) return [];
        return [
          {
            node,
            detail,
            position: screenPosition(position, viewport),
            label: detail.name ?? detail.summary ?? node.name ?? node.id,
          },
        ];
      })
      .sort((a, b) => {
        const rowDiff = a.position.y - b.position.y;
        if (Math.abs(rowDiff) > OVERVIEW_NODE_HEIGHT * viewport.zoom) return rowDiff;
        const colDiff = a.position.x - b.position.x;
        if (colDiff !== 0) return colDiff;
        return a.node.id.localeCompare(b.node.id);
      })
      .slice(0, MAX_GRAPH_REFERENCES)
      .map((entry, index) => ({
        number: index + 1,
        id: entry.node.id,
        entity_type: entry.node.entity_type,
        label: entry.label,
        lifecycle: entry.node.lifecycle,
        href: entry.detail.href ?? entry.node.href ?? null,
      }));
  }, [visibleNodes, details, positions, viewport, size]);

  const referenceNumberByNodeId = useMemo(
    () => new Map(graphReferences.map((reference) => [reference.id, reference.number])),
    [graphReferences],
  );

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    publishGraphReferences(graphId, "overview", graphReferences);
  }, [graphReferences]);

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    return () => clearGraphReferences(graphId);
  }, []);

  useEffect(() => {
    if (!detailUrl || detailIds.length === 0) return;
    const timeout = window.setTimeout(async () => {
      const url = new URL(detailUrl, window.location.origin);
      url.searchParams.set("ids", detailIds.join(","));
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const json = (await res.json()) as { nodes?: OverviewNodeDetail[] };
      setDetails((prev) => {
        const next = new Map(prev);
        for (const node of json.nodes ?? []) next.set(node.id, node);
        return next;
      });
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [detailUrl, detailIds]);

  const flowNodes = useMemo(
    () =>
      visibleNodes.map((node) => {
        const position = positions.get(node.id) ?? { x: 0, y: 0 };
        return {
          id: node.id,
          type: "overviewNode",
          position,
          initialWidth: OVERVIEW_NODE_WIDTH,
          initialHeight: OVERVIEW_NODE_HEIGHT,
          data: {
            node,
            detail: details.get(node.id),
            showDetail: viewport.zoom >= DETAIL_ZOOM,
            referenceNumber: referenceNumberByNodeId.get(node.id),
            isNew: newNodeIds.has(node.id),
          } satisfies OverviewNodeData,
          draggable: false,
          selectable: false,
          connectable: false,
          style: {
            width: OVERVIEW_NODE_WIDTH,
            height: OVERVIEW_NODE_HEIGHT,
            padding: 0,
            background: "transparent",
            border: "none",
          },
        };
      }),
    [visibleNodes, positions, details, viewport.zoom, referenceNumberByNodeId, newNodeIds],
  );

  const flowEdges = useMemo(
    () =>
      visibleLinks.map((link, index) => ({
        id: `${link.source}-${link.target}-${index}`,
        source: link.source,
        target: link.target,
        type: "default",
        selectable: false,
        focusable: false,
        interactionWidth: 0,
        style: {
          stroke: "rgba(115, 115, 115, 0.3)",
          pointerEvents: "none" as const,
        },
      })),
    [visibleLinks],
  );

  const nodeTypes = useMemo(() => ({ overviewNode: OverviewFlowNode }), []);

  return (
    <div className={fillHeight ? "flex h-full min-h-0 flex-col gap-2" : "flex flex-col gap-2"}>
      <div
        ref={graphRef}
        className={
          fillHeight
            ? "neo-inset relative min-h-0 w-full flex-1 overflow-hidden rounded-lg bg-card"
            : "neo-inset relative h-[65vh] min-h-[480px] w-full overflow-hidden rounded-lg bg-card"
        }
      >
        {search ? (
          <div className="nodrag nopan absolute left-3 top-3 z-10 w-64 max-w-[calc(100%-9rem)]">
            {search}
          </div>
        ) : null}
        {visibleNodes.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center text-center text-sm font-medium text-muted-foreground">
            So empty
          </div>
        ) : Flow ? (
          <Flow.ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            onlyRenderVisibleElements
            fitView
            fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
            minZoom={GRAPH_MIN_ZOOM}
            maxZoom={GRAPH_MAX_ZOOM}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick
            preventScrolling
            onInit={(instance: {
              fitView?: (options?: typeof GRAPH_FIT_VIEW_OPTIONS) => void;
              getViewport?: () => FlowViewport;
            }) => {
              if (!hasFitRef.current) {
                instance.fitView?.(GRAPH_FIT_VIEW_OPTIONS);
                hasFitRef.current = true;
              }
              const next = instance.getViewport?.();
              if (next) updateViewport(next);
            }}
            onMove={(_event: unknown, next: FlowViewport) => updateViewport(next)}
            onNodeClick={(_event: unknown, node: { id: string }) => {
              const target = nodeById.get(node.id);
              if (target && onNeuronClick) {
                onNeuronClick(target);
                return;
              }
              if (target?.href) navigate(target.href);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Flow.Background gap={20} size={1} />
            <Flow.Controls
              position="top-right"
              showInteractive={false}
              fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
            />
            <Flow.MiniMap
              pannable
              zoomable
              maskColor="rgba(0, 0, 0, 0.35)"
              nodeColor={(node: { id: string }) => {
                const graphNode = nodeById.get(node.id);
                return graphNode ? lifecycleColor(nodeLifecycle(graphNode)) : "#d4d4d4";
              }}
              nodeStrokeWidth={2}
              style={{
                width: 120,
                height: 90,
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius)",
                overflow: "hidden",
              }}
            />
          </Flow.ReactFlow>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Loading graph…
          </div>
        )}
      </div>

      {controlledMode ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Life cycle:</span>
            {allLifecycles.map((lifecycle) => {
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
                    onChange={() => {
                      setVisibleLifecycles((prev) => {
                        const next = new Set(prev);
                        if (checked) next.delete(lifecycle);
                        else next.add(lifecycle);
                        return next;
                      });
                    }}
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
      )}
    </div>
  );
}
