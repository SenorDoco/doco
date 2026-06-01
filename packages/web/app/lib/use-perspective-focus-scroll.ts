import { useEffect, useRef } from "react";

/**
 * Whether a focus request should fire. We focus only a real, not-yet-applied
 * node id: a falsy id means "nothing to focus", and re-applying the id already
 * in view would yank the scroll on every unrelated re-render.
 */
export function shouldFocusPerspectiveNode(
  focusId: string | null | undefined,
  lastAppliedId: string | null,
): focusId is string {
  return Boolean(focusId) && focusId !== lastAppliedId;
}

/**
 * List-style perspectives (glossary, approval, list, pull requests) have
 * no camera to pan, so "focus the perspective on a node" means scrolling
 * its row into view and pulsing it — the list-view analogue of the canvas
 * perspectives' one-shot `initialFocusId`.
 *
 * Pass the perspective's effective focus id (see
 * {@link effectivePerspectiveFocusId}). When it changes to a node currently
 * rendered in this perspective — matched by the `data-node-id` every list
 * row carries — the row scrolls to center and briefly gets the
 * `doco-perspective-focus-flash` highlight. Opening a node from a dialog
 * edge drives this exactly as a from-scratch URL open does.
 *
 * Only one perspective mounts at a time, and the node dialog and side panel
 * carry no `data-node-id`, so a document-wide lookup resolves unambiguously
 * to the active perspective's row. A focus id with no matching row (the
 * node isn't shown in this perspective) is left un-applied, so a later
 * focus on a node that *is* present still fires.
 */
export function usePerspectiveFocusScroll(focusId: string | null | undefined): void {
  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shouldFocusPerspectiveNode(focusId, appliedRef.current)) return;
    if (typeof document === "undefined") return;
    const target = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focusId)}"]`);
    if (!target) return;
    appliedRef.current = focusId;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("doco-perspective-focus-flash");
    const timer = window.setTimeout(() => {
      target.classList.remove("doco-perspective-focus-flash");
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [focusId]);
}
