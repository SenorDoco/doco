import { Maximize2, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { lifecycleColor } from "~/lib/node-colors";

export interface OverviewGraphNode {
  id: string;
  node_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href?: string | null;
  scopes: { id: string; name: string; icon?: string | null }[];
  is_center?: boolean;
}

export interface OverviewGraphLink {
  source: string;
  target: string;
  edge_type: string;
  attribution?: "explicit" | "doco-auto";
}

export interface OverviewGraphData {
  centerId: string;
  nodes: OverviewGraphNode[];
  links: OverviewGraphLink[];
  detailUrl: string | null;
}

export interface OverviewNodeDetail {
  id: string;
  node_type: string;
  summary: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href?: string | null;
  scopes: { id: string; name: string; icon?: string | null }[];
}

interface OverviewGraphProps extends OverviewGraphData {
  fillHeight?: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const LIFECYCLE_ORDER = [
  "active",
  "drafted",
  "proposed",
  "superseded",
  "abandoned",
  "succeeded",
  "failed",
  "planned",
  "in_progress",
  "retired",
];
const HIDDEN_LIFECYCLES_BY_DEFAULT = new Set(["abandoned", "superseded", "failed", "succeeded"]);
const NODE_TYPE_ORDER = new Map(
  [
    "scope",
    "intent",
    "decision",
    "action",
    "rule",
    "log",
    "eval",
    "reference",
    "idea",
    "state",
  ].map((type, index) => [type, index]),
);
const DETAIL_ZOOM = 0.72;
const MAX_DETAIL_CARDS = 48;

function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replaceAll("_", " ");
}

function nodeLifecycle(node: { lifecycle: string | null }): string {
  return node.lifecycle ?? "active";
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function placeRing<T extends { id: string }>(
  items: T[],
  center: Point,
  radius: number,
  positions: Map<string, Point>,
) {
  if (items.length === 0) return;
  if (items.length === 1) {
    positions.set(items[0].id, { x: center.x, y: center.y });
    return;
  }
  const start = -Math.PI / 2;
  items.forEach((item, index) => {
    const angle = start + (Math.PI * 2 * index) / items.length;
    positions.set(item.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });
}

function placeSpiral(nodes: OverviewGraphNode[], center: Point, positions: Map<string, Point>) {
  const sorted = nodes.slice().sort((a, b) => a.id.localeCompare(b.id));
  sorted.forEach((node, index) => {
    if (index === 0) {
      positions.set(node.id, center);
      return;
    }
    const ring = Math.ceil(Math.sqrt(index));
    const angle = hashString(node.id) * 0.000001 + index * 2.399963229728653;
    const radius = 18 + ring * 15;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });
}

function primaryScope(node: OverviewGraphNode): { id: string; name: string; icon?: string | null } {
  if (node.node_type === "scope") {
    return { id: node.id, name: node.name ?? "Scope", icon: node.scopes[0]?.icon };
  }
  return node.scopes[0] ?? { id: "__unscoped__", name: "Unscoped", icon: null };
}

function layoutNodes(nodes: OverviewGraphNode[], centerId: string): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const scopeNodes = nodes.filter((node) => node.node_type === "scope");
  const childNodes = nodes.filter((node) => node.node_type !== "scope");
  const scopeKeys = Array.from(
    new Set([
      ...scopeNodes.map((node) => node.id),
      ...childNodes.map((node) => primaryScope(node).id),
    ]),
  ).sort((a, b) => {
    if (a === centerId) return -1;
    if (b === centerId) return 1;
    return a.localeCompare(b);
  });

  const scopeCenters = new Map<string, Point>();
  if (scopeKeys.length <= 1) {
    const key = scopeKeys[0] ?? "__unscoped__";
    scopeCenters.set(key, { x: 0, y: 0 });
  } else {
    const pseudo = scopeKeys.map((id) => ({ id }));
    const ring = new Map<string, Point>();
    placeRing(pseudo, { x: 0, y: 0 }, Math.max(420, scopeKeys.length * 105), ring);
    for (const key of scopeKeys) scopeCenters.set(key, ring.get(key) ?? { x: 0, y: 0 });
  }

  for (const scope of scopeNodes) {
    positions.set(scope.id, scopeCenters.get(scope.id) ?? { x: 0, y: 0 });
  }

  const byScope = new Map<string, OverviewGraphNode[]>();
  for (const node of childNodes) {
    const key = primaryScope(node).id;
    const list = byScope.get(key) ?? [];
    list.push(node);
    byScope.set(key, list);
  }

  for (const [scopeId, groupNodes] of byScope) {
    const scopeCenter = scopeCenters.get(scopeId) ?? { x: 0, y: 0 };
    const byKind = new Map<string, OverviewGraphNode[]>();
    for (const node of groupNodes) {
      const key = `${node.node_type}:${nodeLifecycle(node)}`;
      const list = byKind.get(key) ?? [];
      list.push(node);
      byKind.set(key, list);
    }
    const kinds = Array.from(byKind.entries()).sort(([a], [b]) => {
      const [at, al] = a.split(":");
      const [bt, bl] = b.split(":");
      const ai = NODE_TYPE_ORDER.get(at ?? "") ?? 999;
      const bi = NODE_TYPE_ORDER.get(bt ?? "") ?? 999;
      if (ai !== bi) return ai - bi;
      return (al ?? "").localeCompare(bl ?? "");
    });
    const kindCenters = new Map<string, Point>();
    placeRing(
      kinds.map(([id]) => ({ id })),
      scopeCenter,
      Math.max(120, Math.min(360, 80 + kinds.length * 24)),
      kindCenters,
    );
    for (const [kind, kindNodes] of kinds) {
      placeSpiral(kindNodes, kindCenters.get(kind) ?? scopeCenter, positions);
    }
  }

  return positions;
}

function boundsForPositions(positions: Map<string, Point>): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of positions.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) {
    return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  }
  return { minX, minY, maxX, maxY };
}

export function OverviewGraph({
  centerId,
  nodes,
  links,
  detailUrl,
  fillHeight = false,
}: OverviewGraphProps) {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [details, setDetails] = useState<Map<string, OverviewNodeDetail>>(() => new Map());
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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
  const [visibleLifecycles, setVisibleLifecycles] = useState<Set<string>>(
    () =>
      new Set(allLifecycles.filter((lifecycle) => !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle))),
  );

  useEffect(() => {
    setVisibleLifecycles((prev) => {
      const next = new Set<string>();
      for (const lifecycle of allLifecycles) {
        if (prev.has(lifecycle) || !HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle)) {
          next.add(lifecycle);
        }
      }
      return next;
    });
  }, [allLifecycles]);

  const visibleNodes = useMemo(
    () => nodes.filter((node) => visibleLifecycles.has(nodeLifecycle(node))),
    [nodes, visibleLifecycles],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleLinks = useMemo(
    () => links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target)),
    [links, visibleIds],
  );
  const positions = useMemo(() => layoutNodes(visibleNodes, centerId), [visibleNodes, centerId]);
  const worldToScreen = useCallback(
    (point: Point): Point => ({
      x: point.x * viewport.zoom + viewport.x + size.width / 2,
      y: point.y * viewport.zoom + viewport.y + size.height / 2,
    }),
    [size, viewport],
  );
  const screenToWorld = useCallback(
    (point: Point): Point => ({
      x: (point.x - size.width / 2 - viewport.x) / viewport.zoom,
      y: (point.y - size.height / 2 - viewport.y) / viewport.zoom,
    }),
    [size, viewport],
  );

  const fitView = useCallback(() => {
    const b = boundsForPositions(positions);
    const graphWidth = Math.max(1, b.maxX - b.minX + 260);
    const graphHeight = Math.max(1, b.maxY - b.minY + 260);
    const zoom = Math.max(
      0.03,
      Math.min(2, Math.min(size.width / graphWidth, size.height / graphHeight)),
    );
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    setViewport({ x: -cx * zoom, y: -cy * zoom, zoom });
  }, [positions, size]);

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

  useEffect(() => {
    fitView();
  }, [fitView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    ctx.lineWidth = 1;
    for (const link of visibleLinks) {
      const a = positions.get(link.source);
      const b = positions.get(link.target);
      if (!a || !b) continue;
      const from = worldToScreen(a);
      const to = worldToScreen(b);
      if (
        (from.x < -80 && to.x < -80) ||
        (from.y < -80 && to.y < -80) ||
        (from.x > size.width + 80 && to.x > size.width + 80) ||
        (from.y > size.height + 80 && to.y > size.height + 80)
      ) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle =
        link.attribution === "doco-auto" ? "rgba(115,115,115,0.12)" : "rgba(115,115,115,0.22)";
      if (link.attribution === "doco-auto") ctx.setLineDash([4, 4]);
      else ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const node of visibleNodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;
      const p = worldToScreen(pos);
      if (p.x < -24 || p.y < -24 || p.x > size.width + 24 || p.y > size.height + 24) continue;
      const isScope = node.node_type === "scope";
      const r = node.is_center
        ? 7
        : isScope
          ? 5.5
          : Math.max(2.2, Math.min(4.5, 2.6 + viewport.zoom));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = lifecycleColor(nodeLifecycle(node));
      ctx.fill();
      ctx.lineWidth = hoveredId === node.id || node.is_center ? 2 : 1;
      ctx.strokeStyle =
        hoveredId === node.id || node.is_center ? "#111827" : "rgba(255,255,255,0.9)";
      ctx.stroke();
    }
  }, [visibleNodes, visibleLinks, positions, viewport, size, hoveredId, worldToScreen]);

  const detailCandidates = useMemo(() => {
    if (viewport.zoom < DETAIL_ZOOM) return [];
    const candidates = visibleNodes
      .map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const screen = worldToScreen(pos);
        if (
          screen.x < -120 ||
          screen.y < -120 ||
          screen.x > size.width + 120 ||
          screen.y > size.height + 120
        ) {
          return null;
        }
        const dx = screen.x - size.width / 2;
        const dy = screen.y - size.height / 2;
        return { node, screen, distance: dx * dx + dy * dy };
      })
      .filter((item): item is { node: OverviewGraphNode; screen: Point; distance: number } =>
        Boolean(item),
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_DETAIL_CARDS);
    return candidates;
  }, [visibleNodes, positions, viewport, size, worldToScreen]);

  useEffect(() => {
    if (!detailUrl || detailCandidates.length === 0) return;
    const missing = detailCandidates
      .map((candidate) => candidate.node.id)
      .filter((id) => !details.has(id));
    if (missing.length === 0) return;
    const timeout = window.setTimeout(async () => {
      const url = new URL(detailUrl, window.location.origin);
      url.searchParams.set("ids", missing.join(","));
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
  }, [detailUrl, detailCandidates, details]);

  const nearestNode = (screen: Point): OverviewGraphNode | null => {
    let best: OverviewGraphNode | null = null;
    let bestDistance = 12 * 12;
    for (const node of visibleNodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;
      const p = worldToScreen(pos);
      const dx = p.x - screen.x;
      const dy = p.y - screen.y;
      const d = dx * dx + dy * dy;
      if (d < bestDistance) {
        best = node;
        bestDistance = d;
      }
    }
    return best;
  };

  return (
    <div className={fillHeight ? "flex h-full min-h-0 flex-col gap-2" : "flex flex-col gap-2"}>
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
      <div
        ref={containerRef}
        className={
          fillHeight
            ? "relative min-h-0 w-full flex-1 overflow-hidden rounded-md border border-border bg-input"
            : "relative h-[65vh] min-h-[480px] w-full overflow-hidden rounded-md border border-border bg-input"
        }
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag) {
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
              drag.x = event.clientX;
              drag.y = event.clientY;
              setViewport((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            const node = nearestNode({ x: event.clientX - rect.left, y: event.clientY - rect.top });
            setHoveredId(node?.id ?? null);
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            dragRef.current = null;
            if (drag?.moved) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const node = nearestNode({ x: event.clientX - rect.left, y: event.clientY - rect.top });
            if (node?.href) navigate(node.href);
          }}
          onPointerLeave={() => {
            dragRef.current = null;
            setHoveredId(null);
          }}
          onWheel={(event) => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            const before = screenToWorld(mouse);
            const factor = event.deltaY > 0 ? 0.88 : 1.14;
            setViewport((prev) => {
              const zoom = Math.max(0.03, Math.min(3, prev.zoom * factor));
              return {
                zoom,
                x: mouse.x - size.width / 2 - before.x * zoom,
                y: mouse.y - size.height / 2 - before.y * zoom,
              };
            });
          }}
        />
        <div className="absolute right-3 top-3 z-20 flex overflow-hidden rounded-md border border-border bg-card shadow-sm">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center hover:bg-muted"
            title="Zoom in"
            onClick={() => setViewport((prev) => ({ ...prev, zoom: Math.min(3, prev.zoom * 1.2) }))}
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center border-l border-border hover:bg-muted"
            title="Zoom out"
            onClick={() =>
              setViewport((prev) => ({ ...prev, zoom: Math.max(0.03, prev.zoom / 1.2) }))
            }
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center border-l border-border hover:bg-muted"
            title="Fit graph"
            onClick={fitView}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
        <div className="pointer-events-none absolute inset-0 z-10">
          {detailCandidates.map(({ node, screen }) => {
            const detail = details.get(node.id);
            if (!detail) return null;
            const title = detail.name ?? detail.summary;
            return (
              <Link
                key={node.id}
                to={detail.href ?? node.href ?? "#"}
                className="pointer-events-auto absolute w-64 rounded-md border border-border bg-card px-3 py-2 text-card-foreground shadow-md no-underline"
                style={{
                  left: screen.x,
                  top: screen.y,
                  transform: "translate(-50%, calc(-100% - 12px))",
                }}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                  <NodeTypeIcon nodeType={detail.node_type} className="!h-3.5 !w-3.5" />
                  <span>{detail.node_type}</span>
                </div>
                <div className="truncate font-mono text-xs font-semibold text-foreground">
                  {title}
                </div>
                {title !== detail.summary ? (
                  <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted-foreground">
                    {detail.summary}
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
