// Reference links for the BPMN perspective.
//
// References are the project's source/background material — rendered as
// BPMN "document" data objects in a pool's artifacts band. Unlike flow
// nodes they don't sit on the sequence flow, so no `flows_to` arrow ever
// points at them. But a reference is almost always *about* something: the
// Decision it informed, the Action it documents, the Rule it backs. Those
// associations live as ordinary graph edges (supports, attributed_to,
// relates_to, …) incident to the reference node, and the loader already
// includes them in the perspective's `links`.
//
// This module is the pure selection rule for which of those edges to
// surface on the canvas as gray dashed "see also" links. It deliberately
// avoids React / React Flow imports so it can be unit-tested and shared by
// the renderer without dragging the canvas bundle into a test runner —
// same shape as bpmn-subprocess.

export interface ReferenceEdgeLink {
  source: string;
  target: string;
}

export interface ReferenceEdge {
  /** Stable React Flow edge id, derived from the unordered node pair. */
  id: string;
  source: string;
  target: string;
}

/**
 * The association edges to draw as reference links: every edge with at
 * least one endpoint that is a Reference node, where *both* endpoints are
 * currently rendered on the canvas (so a link never dangles off-screen).
 *
 * The emitted edge keeps the original source -> target direction (the
 * renderer wires source's right handle to target's left handle), but a
 * given unordered pair is drawn only once — parallel or reversed edges
 * between the same two nodes collapse to a single line. References never
 * sit on the BPMN sequence flow, so these never overlap the solid
 * `flows_to` arrows; they are a distinct, non-directional "this step cites
 * this material" relationship.
 */
export function referenceEdges(
  links: readonly ReferenceEdgeLink[],
  referenceNodeIds: ReadonlySet<string>,
  renderedNodeIds: ReadonlySet<string>,
): ReferenceEdge[] {
  const edges: ReferenceEdge[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!referenceNodeIds.has(link.source) && !referenceNodeIds.has(link.target)) continue;
    if (!renderedNodeIds.has(link.source) || !renderedNodeIds.has(link.target)) continue;
    const [a, b] =
      link.source < link.target ? [link.source, link.target] : [link.target, link.source];
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `reference:${key}`, source: link.source, target: link.target });
  }
  return edges;
}
