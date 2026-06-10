// Shared numbering / reference-badge logic used by every perspective
// that renders #N badges on its canvas (Graph, BPMN, org-tree, and any
// future React-Flow-based perspective).
//
// Numbers are assigned ONCE per rendered node set — never on pan/zoom.
// There is a single path, two ways to build the ordered list:
//
//   • `referencesFromCandidates` — reading order (rows top-to-bottom,
//     left-to-right) over the rendered candidates' canvas positions. Used
//     by the Graph and org-tree. Because it reads canvas coordinates (not
//     screen coordinates), the numbering is fixed to the node set: panning
//     and zooming never renumber, and a node keeps its #N until the
//     rendered set itself changes (a focus change, a lifecycle-filter
//     toggle, or an edit).
//   • `processReferences` (process-perspective.server-side sibling) — the
//     BPMN perspective builds its list from the focal Intent's membership
//     in creation order instead, so its numbers shift only when a
//     different Intent comes into focus.
//
// Either list flows through `usePublishedReferences`, the single chokepoint
// that applies the cap (MAX_GRAPH_REFERENCES), derives the id→number map the
// badges subscribe to, and keeps the sidebar registry in sync (publish +
// per-unmount clear).
//
// Perspectives still own the shape-specific work — what their candidates
// are, their canvas-space positions, their rendered width/height in canvas
// units. The sort rule, the cap, and the registry plumbing live here.

import { useEffect, useMemo, useRef } from "react";
import {
  type GraphReferenceItem,
  clearGraphReferences,
  publishGraphReferences,
} from "./graph-references";

/**
 * Zoom level below which #N badges are hidden on the Graph. Kept as a single
 * source of truth so the one perspective that hides badges when zoomed far out
 * imports this rather than declaring its own. Hiding is a pure visibility gate
 * — it does NOT renumber, so the numbers reappear unchanged when you zoom back
 * in.
 *
 * 0.1 chosen so the auto-fit zoom on a many-node Doco still surfaces the badges
 * on first paint (0.35 was the previous value and caused medium+ Docos to load
 * blank).
 */
export const REFERENCE_ZOOM_THRESHOLD = 0.1;

/**
 * Hard cap on numbered references per perspective so the sidebar
 * "References" list never grows unbounded on dense Docos.
 */
export const MAX_GRAPH_REFERENCES = 120;

/**
 * Shape every numberable entity is collapsed to before the shared
 * sort/cap/number pass runs. Perspectives translate their own node
 * representation into this; the rest is handled here.
 *
 * `position`, `width`, `height` are in canvas (pre-viewport-transform)
 * coordinates — the reading-order sort uses them directly, which is exactly
 * why the numbering is stable under pan/zoom.
 */
export interface ReferenceCandidate {
  id: string;
  node_type: string;
  label: string;
  lifecycle: string | null;
  href: string | null;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export type GraphReferenceSource = "overview" | "process" | "org-tree";

/**
 * The reading order every perspective numbers by: top-to-bottom by row,
 * then left-to-right within a row, then by id for a deterministic tie
 * break. Two items share a row when their vertical gap is within the
 * taller one's height.
 */
export function compareReadingOrder(
  a: { x: number; y: number; height: number; id: string },
  b: { x: number; y: number; height: number; id: string },
): number {
  const rowDiff = a.y - b.y;
  const tolerance = Math.max(a.height, b.height);
  if (Math.abs(rowDiff) > tolerance) return rowDiff;
  const colDiff = a.x - b.x;
  if (colDiff !== 0) return colDiff;
  return a.id.localeCompare(b.id);
}

/**
 * Build the ordered, numbered reference list from the rendered candidates, in
 * canvas reading order. Pure and viewport-free: the same candidate set always
 * yields the same numbering, so #N never shifts on a pan or zoom — it changes
 * only when the rendered set does. The caller's array is not mutated.
 */
export function referencesFromCandidates(candidates: ReferenceCandidate[]): GraphReferenceItem[] {
  return [...candidates]
    .sort((a, b) =>
      compareReadingOrder(
        { x: a.position.x, y: a.position.y, height: a.height, id: a.id },
        { x: b.position.x, y: b.position.y, height: b.height, id: b.id },
      ),
    )
    .map((candidate, index) => ({
      number: index + 1,
      id: candidate.id,
      node_type: candidate.node_type,
      label: candidate.label,
      lifecycle: candidate.lifecycle,
      href: candidate.href,
    }));
}

interface PerspectiveReferences {
  references: GraphReferenceItem[];
  numberById: Map<string, number>;
}

/**
 * The wiring every perspective shares once it has an *ordered, numbered*
 * reference list: apply the cap, derive the id→number map the badges
 * subscribe to, mirror the list into the sidebar registry under a stable
 * id, and clear that id on unmount.
 *
 * `references` must already be in the intended order, numbered 1..N —
 * `referencesFromCandidates` (reading order) or `processReferences`
 * (creation order) produces it. Either way, this is the single place the
 * cap is enforced and the only place the registry is touched.
 */
export function usePublishedReferences(
  source: GraphReferenceSource,
  references: GraphReferenceItem[],
): PerspectiveReferences {
  const capped = useMemo(
    () =>
      references.length > MAX_GRAPH_REFERENCES
        ? references.slice(0, MAX_GRAPH_REFERENCES)
        : references,
    [references],
  );
  const numberById = useMemo(() => new Map(capped.map((r) => [r.id, r.number])), [capped]);

  const graphIdRef = useRef(`${source}-${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    publishGraphReferences(graphIdRef.current, source, capped);
  }, [capped, source]);
  useEffect(() => {
    const graphId = graphIdRef.current;
    return () => clearGraphReferences(graphId);
  }, []);

  return { references: capped, numberById };
}
