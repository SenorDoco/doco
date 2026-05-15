// Entity-detail graph view (ADR-076, swapped to react-flow per ADR-113).
// Each node shows: type · title · how-long-ago · personalized PageRank.
// Global PageRank is a follow-up (needs a separate globalPageRank function
// in @doco/index — `personalizedPageRank` requires a single source).
//
// react-flow is loaded via dynamic import — it touches the DOM directly,
// can't run during SSR.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import "@xyflow/react/dist/style.css";

export interface GraphNode {
  id: string;
  node_type: string;
  summary: string;
  /** Scopes carry their `name` here; other entity types leave it null. */
  name: string | null;
  created_at: string | null;
  /** Personalized PageRank from the focal node (1.0 = focal node itself). */
  ppr: number;
  /** Global PageRank — uniform-restart PR over the whole Doco graph. */
  gpr: number;
  is_center?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
  edge_type: string;
  /**
   * Where the edge came from. Explicit edges render solid; doco-auto
   * edges render dashed + lighter so the viewer can see which links the
   * LLM proposed vs. which the source declared. Per the
   * `llm-auto-edge-detection-on-capture` ADR.
   */
  attribution?: "explicit" | "doco-auto";
}

interface EntityGraphProps {
  centerId: string;
  nodes: GraphNode[];
  links: GraphLink[];
  hrefFor?: (id: string, nodeType: string) => string;
}

/**
 * Twelve distinct hues, no two visually adjacent. The four most-visible
 * types in the entity-detail graph (decision, scope, intent, principal)
 * occupy widely-separated parts of the wheel so they never read as
 * "all sort of green-ish."
 *   decision  → orange     (warm, action-shaped)
 *   scope     → lime green (categorical neighborhood)
 *   intent    → magenta    (was emerald — collided with scope/lime)
 *   principal → cyan       (was blue — collided with organization/indigo)
 */
const TYPE_COLOR: Record<string, string> = {
  doco: "#525252", // gray
  principal: "#06b6d4", // cyan
  organization: "#6366f1", // indigo
  intent: "#d946ef", // magenta
  idea: "#f43f5e", // rose
  rule: "#dc2626", // red
  decision: "#f97316", // orange
  action: "#7c3aed", // purple
  reasoning: "#eab308", // yellow
  eval: "#0ea5e9", // sky — Eval is the test-definition node (replaces EVO + Evaluation)
  reference: "#a16207", // amber/brown
  scope: "#84cc16", // lime
};
const FALLBACK_COLOR = "#525252";

const TYPE_PLURAL_LABEL: Record<string, string> = {
  doco: "docos",
  principal: "principals",
  organization: "organizations",
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  decision: "decisions",
  action: "actions",
  reasoning: "reasonings",
  eval: "evals",
  reference: "references",
  scope: "scopes",
};

function typePluralLabel(type: string): string {
  return TYPE_PLURAL_LABEL[type] ?? `${type}s`;
}

/** Format an ISO timestamp as "Ns / Nm / Nh / Nd ago". */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const deltaMs = Date.now() - t;
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Phyllotaxis (sunflower-spiral) layout: focal node at origin, remaining
 * nodes placed at angle `i * golden_angle` and radius `step * sqrt(i)`.
 * Ranks by PPR so highest-ranked sit closest. Deterministic, no overlap
 * even at 25+ nodes, and react-flow's fitView zooms it to the viewport.
 *
 * `step` scales with the node-card width: cards are ~240×130 so the
 * inter-node distance needs to be at least ~170 to avoid corner overlap
 * for the inner ring. Higher values give a sparser but more readable layout.
 */
function spiralLayout(
  nodes: GraphNode[],
  centerId: string,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(centerId, { x: 0, y: 0 });
  const others = nodes.filter((n) => n.id !== centerId);
  others.sort((a, b) => b.ppr - a.ppr); // highest PPR first
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~2.4 rad ≈ 137.5°
  const step = 160; // wider than before — node cards are ~240×130 so we need real breathing room
  others.forEach((node, i) => {
    const idx = i + 1;
    const theta = idx * goldenAngle;
    const r = step * Math.sqrt(idx);
    positions.set(node.id, { x: r * Math.cos(theta), y: r * Math.sin(theta) });
  });
  return positions;
}

export function EntityGraph({ centerId, nodes, links, hrefFor }: EntityGraphProps) {
  const navigate = useNavigate();

  // Scope nodes are never shown as neighbors — they're a categorical
  // membership signal, not part of the focal node's reasoning chain. The
  // focal node itself stays visible even when it's a scope (otherwise the
  // graph on a scope-detail page would be empty).
  const allTypes = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) {
      if (n.node_type === "scope") continue;
      set.add(n.node_type);
    }
    return Array.from(set).sort();
  }, [nodes]);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const v = nodes.filter((n) => {
      if (n.id === centerId) return true;
      if (n.node_type === "scope") return false;
      return !hiddenTypes.has(n.node_type);
    });
    const ids = new Set(v.map((n) => n.id));
    const vl = links.filter((l) => {
      const src = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
      const tgt = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
      return ids.has(src) && ids.has(tgt);
    });
    return { nodes: v, links: vl };
  }, [nodes, links, hiddenTypes, centerId]);

  const positions = useMemo(
    () => spiralLayout(visible.nodes, centerId),
    [visible.nodes, centerId],
  );

  // Dynamic import — react-flow uses window/document.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape hatch
  const [Flow, setFlow] = useState<any>(null);
  useEffect(() => {
    let canceled = false;
    import("@xyflow/react").then((mod) => {
      if (!canceled) setFlow(() => mod);
    });
    return () => {
      canceled = true;
    };
  }, []);

  // Round the viewport-window corners inside the MiniMap. React Flow
  // renders the mask as an SVG <path> with two subpaths — an outer rect
  // covering the panel bounds, and the inner viewport rect cut out via
  // `fill-rule: evenodd`. The inner subpath uses sharp `h`/`v` commands
  // (square corners), which read as a square window inside an otherwise-
  // rounded panel. Patch `d` to substitute arc commands so the viewport
  // matches the panel radius. `d` is recomputed on every pan/zoom, so a
  // MutationObserver keeps the rounding applied.
  const graphRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!Flow) return;
    let canceled = false;
    let lastAppliedD = "";

    const roundInner = (path: SVGPathElement) => {
      if (canceled) return;
      const d = path.getAttribute("d") ?? "";
      if (d === lastAppliedD) return;
      // Second `M` starts the inner viewport subpath.
      const innerIdx = d.indexOf("M", 1);
      if (innerIdx < 0) return;
      const inner = d.slice(innerIdx);
      // Parse `M x,y h w v h h -w z` — the rectangular viewport.
      const m = inner.match(/^M([-\d.]+),([-\d.]+)h([-\d.]+)v([-\d.]+)h/);
      if (!m) return;
      const x = Number.parseFloat(m[1]);
      const y = Number.parseFloat(m[2]);
      const w = Number.parseFloat(m[3]);
      const h = Number.parseFloat(m[4]);
      if (!Number.isFinite(x + y + w + h) || w < 12 || h < 12) return;
      const r = Math.min(6, w / 4, h / 4);
      const r2 = r * 2;
      const rounded =
        `M${x + r},${y}` +
        `h${w - r2}a${r},${r} 0 0 1 ${r},${r}` +
        `v${h - r2}a${r},${r} 0 0 1 ${-r},${r}` +
        `h${-(w - r2)}a${r},${r} 0 0 1 ${-r},${-r}` +
        `v${-(h - r2)}a${r},${r} 0 0 1 ${r},${-r}z`;
      const newD = d.slice(0, innerIdx) + rounded;
      if (newD === d) return;
      lastAppliedD = newD;
      path.setAttribute("d", newD);
    };

    let obs: MutationObserver | null = null;
    const attach = () => {
      if (canceled || !graphRef.current) return;
      const path = graphRef.current.querySelector<SVGPathElement>(
        ".react-flow__minimap-mask",
      );
      if (!path) {
        requestAnimationFrame(attach);
        return;
      }
      roundInner(path);
      obs = new MutationObserver(() => roundInner(path));
      obs.observe(path, { attributes: true, attributeFilter: ["d"] });
    };
    attach();
    return () => {
      canceled = true;
      obs?.disconnect();
    };
  }, [Flow]);

  // Card background fades white → neutral-300 as PPR drops. Range is taken
  // across non-focal nodes so the focal AND the highest-PPR neighbor both
  // land at white; weaker neighbors recede toward gray.
  const pprBounds = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const n of visible.nodes) {
      if (n.is_center) continue;
      if (n.ppr < min) min = n.ppr;
      if (n.ppr > max) max = n.ppr;
    }
    return { min, max };
  }, [visible.nodes]);

  const flowNodes = useMemo(
    () =>
      visible.nodes.map((n) => {
        const pos = positions.get(n.id) ?? { x: 0, y: 0 };
        const color = TYPE_COLOR[n.node_type] ?? FALLBACK_COLOR;
        const pprRange = pprBounds.max - pprBounds.min;
        let bg = "rgb(255,255,255)";
        if (n.is_center) {
          bg = "color-mix(in oklch, var(--color-accent) 30%, white)";
        } else if (pprRange > 0) {
          const t = (n.ppr - pprBounds.min) / pprRange;
          const v = Math.round(212 + 43 * t);
          bg = `rgb(${v},${v},${v})`;
        }
        const title = n.name ?? (n.summary.length > 40 ? `${n.summary.slice(0, 40)}…` : n.summary);
        // Subtitle only adds value when the title is a distinct handle (name).
        // For nameless nodes the title already IS the summary — showing it
        // twice (or as a prefix of itself) is noise.
        const subtitle = n.name
          ? n.summary.length > 80
            ? `${n.summary.slice(0, 80)}…`
            : n.summary
          : null;
        const NODE_W = 240;
        return {
          id: n.id,
          position: pos,
          // `initialWidth`/`initialHeight` (not `width`/`height`) so the
          // MiniMap has valid dimensions on first render — ResizeObserver
          // still refines them once the DOM measures. With `width`/`height`,
          // height stayed `undefined` until measurement and the MiniMap's
          // `getInternalNodesBounds` collapsed to 0-height, leaving the
          // mini-map blank.
          initialWidth: NODE_W,
          initialHeight: subtitle ? 100 : 78,
          data: {
            label: (
              <div
                className="flex flex-col gap-0.5 overflow-hidden px-3 py-2"
                style={{ width: NODE_W }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {n.node_type}
                  </span>
                </div>
                <div className="truncate font-mono text-xs font-semibold text-foreground">
                  {title}
                </div>
                {subtitle ? (
                  <div className="overflow-hidden text-[10px] leading-tight text-muted-foreground" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                    {subtitle}
                  </div>
                ) : null}
                <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
                  <span className="truncate">{relativeTime(n.created_at)}</span>
                  {n.is_center ? (
                    <span className="flex shrink-0 items-center gap-2 font-mono">
                      <span className="font-medium text-foreground">Node in focus</span>
                      <span title="Global PageRank (over the whole Doco graph)">
                        GPR <span className="text-foreground">{n.gpr.toFixed(3)}</span>
                      </span>
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2 font-mono">
                      <span title="Personalized PageRank from focal node">
                        PPR <span className="text-foreground">{n.ppr.toFixed(3)}</span>
                      </span>
                      <span title="Global PageRank (over the whole Doco graph)">
                        GPR <span className="text-foreground">{n.gpr.toFixed(3)}</span>
                      </span>
                    </span>
                  )}
                </div>
              </div>
            ),
          },
          style: {
            background: bg,
            // Borders stay gray for every node — the type is signalled by
            // the colored stripe drawn inside the left edge of the card
            // (boxShadow inset). Focal keeps a 2px gray border for weight.
            border: n.is_center
              ? "2px solid var(--color-border)"
              : "1px solid var(--color-border)",
            borderRadius: 8,
            padding: 0,
            width: NODE_W,
            overflow: "hidden",
            boxShadow: `inset 4px 0 0 ${color}`,
          },
          sourcePosition: "right" as const,
          targetPosition: "left" as const,
        };
      }),
    [visible.nodes, positions, pprBounds],
  );

  const flowEdges = useMemo(
    () =>
      visible.links.map((l, i) => {
        const src = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
        const tgt = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
        const isAuto = l.attribution === "doco-auto";
        return {
          id: `${src}-${tgt}-${l.edge_type}-${i}`,
          source: src,
          target: tgt,
          label: isAuto ? `${l.edge_type} (auto)` : l.edge_type,
          labelStyle: {
            fontSize: 9,
            fill: isAuto ? "#a3a3a3" : "#737373",
            pointerEvents: "none" as const,
          },
          labelBgPadding: [2, 4] as [number, number],
          labelBgBorderRadius: 4,
          labelBgStyle: { fill: "#f5f5f5", fillOpacity: 0.9, pointerEvents: "none" as const },
          // Edges are visual only — never the click target. Removing the
          // invisible hit zone and label pointer-events lets the pan handler
          // receive drag-mousedowns that happen to start on an edge line or
          // its label, so the cursor has the whole canvas to grab.
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          // Auto-detected edges render dashed + lighter so the eye can tell
          // them apart from explicit (person/agent-authored) ones.
          style: isAuto
            ? {
                stroke: "rgba(112, 122, 35, 0.25)",
                strokeDasharray: "4 4",
                pointerEvents: "none" as const,
              }
            : { stroke: "rgba(112, 122, 35, 0.5)", pointerEvents: "none" as const },
        };
      }),
    [visible.links],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="text-muted-foreground">Show:</span>
        {allTypes.map((t) => {
          const v = !hiddenTypes.has(t);
          const color = TYPE_COLOR[t] ?? FALLBACK_COLOR;
          const label = typePluralLabel(t);
          return (
            <label
              key={t}
              className="inline-flex cursor-pointer select-none items-center gap-1"
              title={label}
            >
              <input
                type="checkbox"
                checked={v}
                onChange={() => {
                  setHiddenTypes((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(t);
                    else next.delete(t);
                    return next;
                  });
                }}
                className="h-3 w-3"
              />
              <span style={{ color }}>{label}</span>
            </label>
          );
        })}
      </div>

      <div
        ref={graphRef}
        className="relative h-[65vh] min-h-[480px] w-full overflow-hidden rounded-md border border-border bg-input"
      >
        {Flow ? (
          <Flow.ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            fitView
            fitViewOptions={{ padding: 0.05, maxZoom: 1.6 }}
            onNodeClick={(_e: unknown, n: { id: string }) => {
              const node = visible.nodes.find((x) => x.id === n.id);
              if (!node) return;
              // hrefFor is always provided by callers in production; the fallback exists
              // only for ad-hoc tests/storybook. Use the short form (no `/e/`).
              const href = hrefFor ? hrefFor(node.id, node.node_type) : `/${node.node_type}/${node.id}`;
              navigate(href);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Flow.Background gap={20} size={1} />
            <Flow.Controls showInteractive={false} />
            <Flow.MiniMap
              nodeColor={(n: { id: string }) =>
                TYPE_COLOR[visible.nodes.find((x) => x.id === n.id)?.node_type ?? ""] ??
                FALLBACK_COLOR
              }
              pannable
              zoomable
              maskColor="rgba(0, 0, 0, 0.35)"
              style={{
                width: 120,
                height: 90,
                border: "1px solid var(--color-border)",
                // Match the parent graph container's `rounded-md` so the
                // MiniMap nests cleanly inside Doco's component radii.
                borderRadius: "var(--radius)",
                // The inner SVG mask path is a rectangle — without
                // clipping, the dark mask-fill corners poke past the
                // rounded panel border. `overflow: hidden` clips the SVG
                // to the rounded panel shape.
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
    </div>
  );
}
