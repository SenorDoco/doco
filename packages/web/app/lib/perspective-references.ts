// Shared numbering / reference-badge logic used by every perspective
// that renders #N badges on its canvas (Graph, BPMN, and any future
// React-Flow-based perspective).
//
// Behaviour every perspective gets by being routed through
// `usePerspectiveReferences`:
//
//   • Same zoom threshold below which numbers vanish
//     (REFERENCE_ZOOM_THRESHOLD). One knob, not one per perspective.
//   • Same visibility check — a candidate must be on-screen (with a
//     scaled padding equal to its own size) to receive a number.
//   • Same sort order — top-to-bottom by screen-row, then
//     left-to-right within a row, then by id for determinism.
//   • Same cap (MAX_GRAPH_REFERENCES) so the sidebar list stays
//     manageable on dense Dococs.
//   • Same registry publish + per-unmount clear so the sidebar
//     references list stays in sync without each perspective
//     re-implementing the wiring.
//
// Perspectives still own the shape-specific work — what their
// candidates are, their canvas-space positions, their rendered
// width/height in canvas units. Anything orthogonal to those (the
// sort, the cap, the registry plumbing) lives here.

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
 * 0.1 chosen so the auto-fit zoom on a many-neuron Doco still
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

export type GraphReferenceSource = "overview" | "bpmn";

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
    const remaining = Math.max(0, MAX_GRAPH_REFERENCES - priority.length);
    if (remaining === 0) return priority;

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
      .sort((a, b) => {
        const rowDiff = a.screenY - b.screenY;
        const tolerance = Math.max(a.scaledH, b.scaledH);
        if (Math.abs(rowDiff) > tolerance) return rowDiff;
        const colDiff = a.screenX - b.screenX;
        if (colDiff !== 0) return colDiff;
        return a.candidate.id.localeCompare(b.candidate.id);
      })
      .slice(0, remaining)
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

  const numberById = useMemo(() => new Map(references.map((r) => [r.id, r.number])), [references]);

  const graphIdRef = useRef(`${source}-${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    publishGraphReferences(graphIdRef.current, source, references);
  }, [references, source]);
  useEffect(() => {
    const graphId = graphIdRef.current;
    return () => clearGraphReferences(graphId);
  }, []);

  return { references, numberById };
}
