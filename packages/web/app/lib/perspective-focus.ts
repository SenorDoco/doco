/**
 * Which node a perspective should treat as its one-shot camera focus —
 * the `initialFocusId` that pans and zooms the canvas onto a node at 100%
 * zoom, the same affordance you get when a node's URL is opened from
 * scratch. (This is distinct from `centerId`, which only recomputes
 * depth-fade and the render window without moving the viewport.)
 *
 * Two things can ask for that focus:
 *
 *   • `routeFocusId` — the node (or edge source) named by the current
 *     URL, resolved by the loader. Set when the page boots directly on a
 *     node/edge URL.
 *
 *   • `clientFocusId` — a node opened *client-side* from a side panel
 *     without re-running the loader: clicking an edge row inside an open
 *     node or edge dialog. Those targets can sit anywhere in the graph —
 *     usually off-screen — so opening one should re-center the canvas on
 *     it, exactly as if its URL had been opened from scratch.
 *
 * The client focus is the more recent, more specific intent, so it wins;
 * when it's absent we fall back to the route focus, and to nothing when
 * neither is set.
 */
export function effectivePerspectiveFocusId(
  clientFocusId: string | null,
  routeFocusId: string | null,
): string | null {
  return clientFocusId ?? routeFocusId;
}

/**
 * The node the active perspective should re-center on — its render
 * window, depth-fade, and camera — given the loader's *focus* fields.
 *
 * Crucially this reads the focus fields (`focusedNodeId`, and an edge's
 * source node via `focusedEdgeFromId`), NOT the dialog-detail fields
 * (`selectedNode` / `selectedEdge`). The detail is nulled under
 * `?dialog=skip` — the URL Señor Doco's auto-focus uses to move the
 * camera without popping the overlay over the chat — but the focus
 * fields survive, so the perspective keeps following the node/edge the
 * agent just touched instead of staying parked on the previous one.
 * Returns null when nothing is focused.
 */
export function perspectiveCenterId(focus: {
  focusedNodeId: string | null;
  focusedEdgeFromId: string | null;
}): string | null {
  return focus.focusedNodeId ?? focus.focusedEdgeFromId ?? null;
}
