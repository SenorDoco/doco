// Shared numbering / reference-badge logic used by every perspective
// that renders #N badges on its canvas (Graph, BPMN, and any future
// React-Flow-based perspective).
//
// Two layers, so a perspective can take only what it needs:
//
//   • `usePerspectiveReferences` — viewport-driven numbering. Culls
//     candidates to what's on-screen, sorts them in reading order (via
//     `compareReadingOrder`), and renumbers on every pan/zoom so #N
//     tracks on-screen reading order. Used by the Graph and org-tree.
//     Numbers below REFERENCE_ZOOM_THRESHOLD vanish — one knob, not one
//     per perspective.
//   • `usePublishedReferences` — the plumbing under that: given an
//     already-ordered, numbered list it applies the cap
//     (MAX_GRAPH_REFERENCES), derives the id→number map the badges
//     subscribe to, and keeps the sidebar registry in sync (publish +
//     per-unmount clear). The BPMN perspective builds its list from its
//     canvas layout (`processReferences`, viewport-independent) and
//     calls this directly, so its numbers shift only when the rendered
//     Intent set changes — never on a pan.
//
// Perspectives still own the shape-specific work — what their
// candidates are, their canvas-space positions, their rendered
// width/height in canvas units. The sort rule, the cap, and the registry
// plumbing live here.

import { useEffect, useMemo, useRef } from "react";
import {
  type GraphReferenceItem,
  clearGraphReferences,
  publishGraphReferences,
} from "./graph-references";

/**
 * Zoom level below which #N badges disappear across every
 * perspective. Single source of truth — each perspective imports
 * this rather than declaring its own.
 *
 * 0.1 chosen so the auto-fit zoom on a many-node Doco still
 * surfaces the badges on first paint (0.35 was the previous value
 * and caused medium+ Dococs to load blank).
 */
export const REFERENCE_ZOOM_THRESHOLD = 0.1;

/**
 * Hard cap on numbered references per perspective so the sidebar
 * "References" list never grows unbounded on dense Dococs.
 */
export const MAX_GRAPH_REFERENCES = 120;

export interface PerspectiveViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PerspectiveSize {
  width: number;
  height: number;
}

/**
 * Shape every numberable entity is collapsed to before the shared
 * sort/cap/number pass runs. Perspectives translate their own node
 * representation into this; the hook handles the rest.
 *
 * `position`, `width`, `height` are in canvas (pre-viewport-
 * transform) coordinates — the hook multiplies by `viewport.zoom` to
 * decide on-screen visibility and ordering.
 */
export interface ReferenceCandidate {
  id: string;
  entity_type: string;
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
 * taller one's height. The coordinates are screen-space for the
 * viewport-driven perspectives (Graph, org-tree — re-sorted each pan) and
 * canvas-space for the BPMN perspective (fixed to the layout); the rule
 * itself is identical, so it lives here once.
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

interface UsePerspectiveReferencesArgs {
  /** Identifies which perspective is publishing — feeds the sidebar. */
  source: GraphReferenceSource;
  /** Current React Flow viewport (pan + zoom). */
  viewport: PerspectiveViewport;
  /** Canvas's rendered size in screen pixels. */
  size: PerspectiveSize;
  /** Candidates to sort, cap, and number. */
  candidates: ReferenceCandidate[];
  /**
   * Items that always come first in the numbering, before any
   * candidates. BPMN uses this for principal-owned swimlanes so the
   * actor's #N lands ahead of every shape in their lane.
   *
   * MUST already carry the desired `number: 1..N` values; the hook
   * does not re-number them.
   */
  priorityItems?: GraphReferenceItem[];
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
 * `references` must already be in the intended order, numbered 1..N.
 * `usePerspectiveReferences` produces that list from a viewport-culled
 * sort; the BPMN perspective produces it from its canvas layout
 * (`processReferences`). Either way, this is the single place the cap is
 * enforced and the only place the registry is touched.
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

export function usePerspectiveReferences({
  source,
  viewport,
  size,
  candidates,
  priorityItems,
}: UsePerspectiveReferencesArgs): PerspectiveReferences {
  const priority = priorityItems ?? [];

  const references = useMemo<GraphReferenceItem[]>(() => {
    if (viewport.zoom < REFERENCE_ZOOM_THRESHOLD) return [];

    const visible = candidates
      .flatMap((c) => {
        const screenX = c.position.x * viewport.zoom + viewport.x;
        const screenY = c.position.y * viewport.zoom + viewport.y;
        const scaledW = c.width * viewport.zoom;
        const scaledH = c.height * viewport.zoom;
        if (
          screenX < -scaledW ||
          screenY < -scaledH ||
          screenX > size.width + scaledW ||
          screenY > size.height + scaledH
        ) {
          return [];
        }
        return [{ candidate: c, screenX, screenY, scaledH }];
      })
      .sort((a, b) =>
        compareReadingOrder(
          { x: a.screenX, y: a.screenY, height: a.scaledH, id: a.candidate.id },
          { x: b.screenX, y: b.screenY, height: b.scaledH, id: b.candidate.id },
        ),
      )
      .map<GraphReferenceItem>((entry, index) => ({
        number: priority.length + index + 1,
        id: entry.candidate.id,
        entity_type: entry.candidate.entity_type,
        label: entry.candidate.label,
        lifecycle: entry.candidate.lifecycle,
        href: entry.candidate.href,
      }));

    return [...priority, ...visible];
  }, [viewport, size, candidates, priority]);

  return usePublishedReferences(source, references);
}
