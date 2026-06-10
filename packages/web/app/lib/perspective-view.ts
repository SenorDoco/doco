// The single description of "what stage am I looking at" inside the Doco
// perspective view, and the one bridge between that stage and the browser
// history entry that restores it.
//
// The perspective view (graph / process / list / …) deliberately does NOT run a
// React Router navigation when you open an overlay or drill into a process —
// that would re-run the heavy loader and remount the canvas. Instead it pushes
// a `window.history` entry itself and keeps the stage in React state. The defect
// this module exists to remove: that was done THREE different ways — node/edge
// overlays pushed a marker, a process drill pushed an empty `{}` (so Back could
// not restore it, and the drilled-pool state lived inside the canvas where
// history could not reach it), and closing replaced the entry instead of
// stacking one. Back/Forward therefore could not reproduce the previous stage.
//
// Here every navigable stage — the bare overview, a drilled process pool, an
// open node overlay, an open edge overlay (and the pool-header case that is BOTH
// a drill and an overlay) — is ONE `PerspectiveView`. Opening any stage pushes
// exactly one history entry carrying that view; one `popstate` read restores the
// whole stage from it. Because the drilled process is part of the view (not
// canvas-private state), Back pops the canvas in and out exactly as it pops an
// overlay open and shut.

/** An open node detail overlay, plus the focal node it frames. */
export interface NodeOverlay {
  kind: "node";
  /** Entity-type URL segment (decision, intent, principal, action, …). */
  nodeType: string;
  id: string;
  /** Detail-fetch href the overlay re-loads from when restored. */
  href: string;
}

/** An open edge detail overlay, plus the two endpoints it frames. */
export interface EdgeOverlay {
  kind: "edge";
  id: string;
  source: string | null;
  target: string | null;
  href: string;
}

/** The detail overlay shown on top of the perspective, if any. */
export type Overlay = { kind: "none" } | NodeOverlay | EdgeOverlay;

/** The complete, restorable description of one perspective-view stage. */
export interface PerspectiveView {
  /** Active perspective slug; "graph" is the default/home perspective. */
  perspective: string;
  /**
   * The process pool drilled into its own swim lanes (process perspective),
   * or null for the overview. Independent of `overlay`: a pool-header click
   * both drills a pool AND opens that process's overlay.
   */
  expandedProcessId: string | null;
  /** The detail overlay (and its focal node/edge) shown on top. */
  overlay: Overlay;
}

/** The version tag that marks a history entry as one of ours. */
interface PerspectiveViewHistoryState extends PerspectiveView {
  docoView: 1;
}

/** Build the history state stored when navigating to a stage. */
export function perspectiveViewHistoryState(view: PerspectiveView): PerspectiveViewHistoryState {
  return { docoView: 1, ...view };
}

/**
 * The shareable address-bar URL for a stage. The address bar is for sharing
 * and reload; the full-fidelity stage rides in the history STATE (above), so
 * the URL only needs to round-trip on a cold load:
 *
 *   • a node/edge overlay → that entity's detail URL (the loader opens it);
 *   • a drilled process with no overlay → a focus-only action link
 *     (`?dialog=skip` centers/drills without popping an overlay);
 *   • otherwise the bare perspective.
 *
 * `?perspective=<slug>` is appended for every non-graph perspective.
 */
export function perspectiveViewUrl(handle: string, view: PerspectiveView): string {
  const base = `/${handle}`;
  const params = new URLSearchParams();
  if (view.perspective && view.perspective !== "graph") {
    params.set("perspective", view.perspective);
  }

  let path = base;
  if (view.overlay.kind === "node") {
    path = `${base}/${view.overlay.nodeType}/${view.overlay.id}`;
  } else if (view.overlay.kind === "edge") {
    path = `${base}/edges/${view.overlay.id}`;
  } else if (view.expandedProcessId) {
    // A drilled pool with no overlay: focus the process Action without popping
    // its detail overlay.
    path = `${base}/action/${view.expandedProcessId}`;
    params.set("dialog", "skip");
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readOverlay(value: unknown): Overlay | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.kind === "none") return { kind: "none" };
  if (o.kind === "node") {
    if (typeof o.nodeType !== "string" || typeof o.id !== "string" || typeof o.href !== "string") {
      return null;
    }
    return { kind: "node", nodeType: o.nodeType, id: o.id, href: o.href };
  }
  if (o.kind === "edge") {
    if (typeof o.id !== "string" || typeof o.href !== "string") return null;
    return {
      kind: "edge",
      id: o.id,
      source: optionalString(o.source),
      target: optionalString(o.target),
      href: o.href,
    };
  }
  return null;
}

/**
 * Resolve a popped `history.state` to the stage it represents, or null when the
 * entry is not one of ours — React Router's own `{ usr, key, idx }`, a bare
 * cold-load entry, or a malformed marker. A null result means "not ours to
 * reconcile": the caller leaves the loader-driven render in place.
 */
export function readPerspectiveView(state: unknown): PerspectiveView | null {
  if (!state || typeof state !== "object") return null;
  const r = state as Record<string, unknown>;
  if (r.docoView !== 1) return null;
  if (typeof r.perspective !== "string") return null;
  const overlay = readOverlay(r.overlay);
  if (!overlay) return null;
  const expandedProcessId = typeof r.expandedProcessId === "string" ? r.expandedProcessId : null;
  return { perspective: r.perspective, expandedProcessId, overlay };
}
