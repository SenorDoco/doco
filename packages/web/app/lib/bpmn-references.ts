// Reference links for the BPMN perspective.
//
// References are the project's source/background material — rendered as
// BPMN "document" data objects in a pool's artifacts band. They carry no
// `flows_to` sequence edges, so by sequence depth alone they'd all collapse
// into column 0 (the far left of the band). But a reference is almost
// always *about* something: the Decision it informed, the Action it
// documents, the Rule it backs — associations that live as ordinary graph
// edges (supports, attributed_to, relates_to, …) incident to the reference.
//
// Two pure rules live here, both free of React / React Flow imports so they
// can be unit-tested and shared by the renderer without dragging the canvas
// bundle into a test runner (same shape as bpmn-subprocess):
//   - referenceAnchorColumns: where to *place* each reference — under the
//     step it cites, so its link is short.
//   - referenceEdges: which association edges to *draw* as gray dashed
//     "see also" links.

export interface ReferenceNode {
  id: string;
  entity_type: string;
}

export interface ReferenceLink {
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
 * The column (sequence depth) to place each Reference in: the column of the
 * non-reference step it cites. Placing a reference in its citing step's
 * column drops it directly under that step in the artifacts band, so the
 * dashed "see also" link is a short near-vertical hop instead of a
 * canvas-spanning diagonal from a left-hand pile.
 *
 * Returns a map of reference id -> anchor column, suitable for overlaying
 * onto the depth map fed to packBpmnLaneColumns. Only references with a
 * real (non-reference) anchor appear; the rest keep their default column 0.
 * A reference cited by several steps picks the shallowest (leftmost) anchor
 * so it never drifts right past the earliest step that cites it; ties break
 * by anchor id for determinism. A step missing from `depthByNode` is treated
 * as column 0 (sequence sources are depth 0).
 */
export function referenceAnchorColumns(
  nodes: readonly ReferenceNode[],
  links: readonly ReferenceLink[],
  depthByNode: ReadonlyMap<string, number>,
): Map<string, number> {
  const referenceIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const node of nodes) {
    if (node.entity_type === "reference") referenceIds.add(node.id);
    else stepIds.add(node.id);
  }
  if (referenceIds.size === 0) return new Map();

  // Best (shallowest, id-tiebroken) anchor seen so far for each reference.
  const bestByRef = new Map<string, { depth: number; id: string }>();
  const consider = (refId: string, anchorId: string) => {
    if (!referenceIds.has(refId)) return;
    if (!stepIds.has(anchorId)) return; // anchor must be a real, non-reference step
    const depth = depthByNode.get(anchorId) ?? 0;
    const current = bestByRef.get(refId);
    if (!current || depth < current.depth || (depth === current.depth && anchorId < current.id)) {
      bestByRef.set(refId, { depth, id: anchorId });
    }
  };
  for (const link of links) {
    consider(link.source, link.target);
    consider(link.target, link.source);
  }

  const columns = new Map<string, number>();
  for (const [refId, best] of bestByRef) columns.set(refId, best.depth);
  return columns;
}

/**
 * The association edges to draw as reference links: every edge with at
 * least one endpoint that is a Reference node, where *both* endpoints are
 * currently rendered on the canvas (so a link never dangles off-screen).
 *
 * The emitted edge keeps the original source -> target direction (the
 * renderer wires source's right handle to target's left handle), but a
 * given unordered pair is drawn only once — parallel or reversed edges
 * between the same two nodes collapse to a single line. References never sit
 * on the BPMN sequence flow, so these never overlap the solid `flows_to`
 * arrows; they are a distinct, non-directional "this step cites this
 * material" relationship.
 */
export function referenceEdges(
  links: readonly ReferenceLink[],
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
