/**
 * Where the UI should auto-focus when Señor Doco touches a node or edge.
 *
 * When the agent reads, creates, updates, or otherwise modifies a node
 * or an edge while the user has the Doco open, the active perspective
 * should re-focus on that node/edge so the user can watch the change
 * land. This module is the pure URL plumbing behind that behavior; the
 * sidebar wires it to the SSE stream and to React Router navigation.
 *
 * Two invariants the helpers here exist to enforce:
 *
 *   • Edges are first-class. A node and an edge are equally focusable.
 *     Centering on an edge means centering on its source node, which the
 *     Doco-home loader resolves from the edge's id-keyed detail URL.
 *
 *   • Focus applies to ALL perspectives. The focus URL carries the
 *     perspective the user is currently viewing (graph, list, BPMN, …)
 *     so the agent's change is highlighted *there*, instead of yanking
 *     the user back to the default graph. `dialog=skip` keeps the detail
 *     overlay from popping over the chat — we only move the camera.
 */

import { normalizeNodeType } from "@doco/shared";

/** A node/edge/policy the UI can move to so the agent's work is visible. */
export interface FocusTarget {
  /** Route pathname to focus, with no query string. */
  pathname: string;
  /**
   * Whether the active `perspective` query param should ride along.
   * True for node/edge focus (they render inside a perspective); false
   * for the standalone policy editor, which has no perspective.
   */
  perspectiveAware: boolean;
}

/**
 * A create whose server-generated id isn't in the request path — it only
 * arrives in the response body — so we stash the shape at request time
 * and resolve the focus target once the result streams back.
 */
export type PendingCreate =
  | { kind: "node"; handle: string; entityType: string }
  | { kind: "edge"; handle: string }
  | { kind: "policy"; handle: string };

// /<handle>/api/<plural>/<id>.json — a single resource addressed by id.
const RESOURCE_PATH = /^\/([^/]+)\/api\/([^/]+)\/([^/.]+)\.(?:json|txt)$/;
// /<handle>/api/<plural>.json — a collection (create endpoint).
const COLLECTION_PATH = /^\/([^/]+)\/api\/([^/]+)\.(?:json|txt)$/;

const PLACEHOLDER_ORIGIN = "https://doco.local";

/** Resolve the focus target for a `<plural>`/`<id>` pair, or null when the
 *  segment isn't a focusable node/edge/policy type. */
function focusTargetForResource(handle: string, plural: string, id: string): FocusTarget | null {
  if (plural === "edges") {
    return { pathname: `/${handle}/edges/${id}`, perspectiveAware: true };
  }
  if (plural === "policies") {
    return { pathname: `/${handle}/policies/${id}/edit`, perspectiveAware: false };
  }
  const entityType = normalizeNodeType(plural);
  if (!entityType) return null;
  return { pathname: `/${handle}/${entityType}/${id}`, perspectiveAware: true };
}

/**
 * Focus target for a `doco_api` request that addresses one resource by id
 * — a read, update, or delete of an existing node/edge/policy
 * (`/<handle>/api/<plural>/<id>.json`). Null for collection endpoints or
 * anything that isn't a Doco API path.
 */
export function focusTargetForResourcePath(apiPath: string): FocusTarget | null {
  const m = RESOURCE_PATH.exec(apiPath);
  if (!m) return null;
  return focusTargetForResource(m[1], m[2], m[3]);
}

/**
 * Describe a create the agent is making (`POST /<handle>/api/<plural>.json`)
 * so the matching result — which carries the new id — can be focused.
 * Batch endpoints like `changesets` aren't focusable to a single target
 * and fall through to null.
 */
export function pendingCreateForRequest(apiPath: string, method: string): PendingCreate | null {
  if (method.toUpperCase() !== "POST") return null;
  const m = COLLECTION_PATH.exec(apiPath);
  if (!m) return null;
  const [, handle, plural] = m;
  if (plural === "edges") return { kind: "edge", handle };
  if (plural === "policies") return { kind: "policy", handle };
  const entityType = normalizeNodeType(plural);
  if (!entityType) return null;
  return { kind: "node", handle, entityType };
}

/** Focus target for a create once its server-generated id is known. */
export function focusTargetForCreate(pending: PendingCreate, id: string): FocusTarget {
  if (pending.kind === "edge") {
    return { pathname: `/${pending.handle}/edges/${id}`, perspectiveAware: true };
  }
  if (pending.kind === "policy") {
    return { pathname: `/${pending.handle}/policies/${id}/edit`, perspectiveAware: false };
  }
  return { pathname: `/${pending.handle}/${pending.entityType}/${id}`, perspectiveAware: true };
}

/**
 * Recognize a node/edge focus URL the agent asked to open via the
 * `navigate` tool, canonicalizing plural node segments
 * (`/h/decisions/<id>` → `/h/decision/<id>`). Returns null for list
 * pages, settings, the edge index, off-site URLs, and anything that
 * isn't a single node/edge — those navigate verbatim.
 */
export function focusTargetForNavigateUrl(rawUrl: string): FocusTarget | null {
  if (!rawUrl.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(rawUrl, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return null;
  const [handle, mid, id] = segments;
  if (mid === "edges") {
    return { pathname: `/${handle}/edges/${id}`, perspectiveAware: true };
  }
  const entityType = normalizeNodeType(mid);
  if (!entityType) return null;
  return { pathname: `/${handle}/${entityType}/${id}`, perspectiveAware: true };
}

/** The active perspective slug from a location search string, or null. */
export function perspectiveParam(search: string): string | null {
  try {
    return new URLSearchParams(search).get("perspective");
  } catch {
    return null;
  }
}

/**
 * Build the URL that re-focuses the perspective on a node/edge: always
 * `dialog=skip` (move the camera without popping the detail overlay over
 * the chat) and, for perspective-aware targets, the active perspective
 * so the focus lands wherever the user is looking — graph, list, BPMN,
 * and the rest — not always the default graph.
 */
export function focusNavigationUrl(target: FocusTarget, perspective: string | null): string {
  const params = new URLSearchParams();
  if (target.perspectiveAware && perspective) {
    params.set("perspective", perspective);
  }
  params.set("dialog", "skip");
  return `${target.pathname}?${params.toString()}`;
}
