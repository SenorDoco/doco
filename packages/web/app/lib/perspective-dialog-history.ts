// Back/forward reconciliation for the perspective detail overlays.
//
// Opening a node or edge detail overlay pushes a browser history entry
// via `window.history.pushState`, tagging the entry's state with a
// marker (`docoNodeDialog` / `docoEdgeDialog`) plus enough data to
// re-open that same overlay. The overlay is client-only — it never runs
// a React Router navigation — so React Router's own location never
// moves. Without a `popstate` handler that reads these markers, pressing
// Back changes the address bar while leaving the overlay stranded on
// screen (and the bare perspective never re-opens its overlay on
// Forward). These helpers turn a popped history state back into the
// overlay that entry represents so a single listener can re-open or
// close the overlay to match the URL.

/** History-state shape stored for a node detail overlay entry. */
export interface NodeDialogHistoryState {
  docoNodeDialog: string;
  /** Entity-type URL segment (decision, intent, principal, …). */
  entityType?: string;
  /** Href the address bar was set to for this entry. */
  href?: string;
}

/** History-state shape stored for an edge detail overlay entry. */
export interface EdgeDialogHistoryState {
  docoEdgeDialog: string;
  source?: string;
  target?: string;
  href?: string;
}

/** What overlay a popped history entry should resolve to. */
export type DialogHistoryAction =
  | { kind: "node"; id: string; entityType: string; href: string | null }
  | { kind: "edge"; id: string; source: string | null; target: string | null; href: string | null }
  | { kind: "none" };

/** Build the history state stored when opening a node detail overlay. */
export function nodeDialogHistoryState(
  id: string,
  entityType: string,
  href: string,
): NodeDialogHistoryState {
  return { docoNodeDialog: id, entityType, href };
}

/** Build the history state stored when opening an edge detail overlay. */
export function edgeDialogHistoryState(
  id: string,
  source: string | null,
  target: string | null,
  href: string,
): EdgeDialogHistoryState {
  return {
    docoEdgeDialog: id,
    source: source ?? undefined,
    target: target ?? undefined,
    href,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Resolve a popped `history.state` to the overlay it represents. Entries
 * without a recognised marker (React Router's own `{ usr, key, idx }`,
 * `null`, a bare perspective URL) resolve to `none` so the listener
 * dismisses any open overlay.
 */
export function readDialogHistoryState(state: unknown): DialogHistoryAction {
  if (state && typeof state === "object") {
    const record = state as Record<string, unknown>;
    if (typeof record.docoNodeDialog === "string") {
      return {
        kind: "node",
        id: record.docoNodeDialog,
        entityType: typeof record.entityType === "string" ? record.entityType : "",
        href: optionalString(record.href),
      };
    }
    if (typeof record.docoEdgeDialog === "string") {
      return {
        kind: "edge",
        id: record.docoEdgeDialog,
        source: optionalString(record.source),
        target: optionalString(record.target),
        href: optionalString(record.href),
      };
    }
  }
  return { kind: "none" };
}

/**
 * Recover the entity-type segment from a node detail pathname
 * (`/<handle>/<type>/<id>`). Used as a fallback when a history entry
 * predates the stored `entityType` field. Returns null for any pathname
 * that isn't an entity detail URL.
 */
export function entityTypeFromPathname(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  // [handle, type, id] — exactly the entity detail shape.
  return parts.length === 3 ? parts[1] : null;
}
