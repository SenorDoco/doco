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
    let timer: number | undefined;
    // Defer one frame before scrolling. The focus id changes in the same React
    // commit as the dialog swap and the lifecycle-filter update, and that
    // commit's reflow cancels a smooth scroll fired synchronously here before
    // it moves (an instant scroll on the next frame lands and stays). The
    // pulse draws the eye in lieu of the animation.
    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({ block: "center" });
      target.classList.add("doco-perspective-focus-flash");
      timer = window.setTimeout(() => {
        target.classList.remove("doco-perspective-focus-flash");
      }, 1600);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [focusId]);
}
