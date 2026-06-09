/**
 * Camera-reset key for the canvas perspectives (Graph, org-tree, process).
 *
 * A perspective re-frames to its cold-start fit (the same `fitView` it runs on
 * mount) whenever this key changes — which is exactly on:
 *   • a revalidation: a fresh load of nodes/edges advances the change cursor
 *     (cold start, the viewer's own edit, or clicking "Refresh"); and
 *   • a lifecycle-filter change (trigger b).
 *
 * It deliberately takes NO focus/center input. Focusing a node (trigger c)
 * changes neither the cursor nor the filter, so the key — and the camera —
 * stays put, leaving the focus framing to do its job. "View subprocess" (d)
 * and "Home" (e) re-frame through their own pool-fit paths, so they aren't
 * encoded here either.
 */
export function fitResetKey(
  changeCursor: string | null,
  visibleLifecycles: Iterable<string>,
): string {
  return `${changeCursor ?? ""}|${[...visibleLifecycles].sort().join(",")}`;
}
