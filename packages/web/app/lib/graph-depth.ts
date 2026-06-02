// Per-node BFS depth from a focused node, plus an opacity ramp that
// fades nodes further from the focus. Used by every graph perspective
// (overview, BPMN, entity-detail) so the rule stays the same wherever
// a focal node is shown:
//
//   • focus                 → 100% opacity
//   • 1 hop                 → 75%
//   • 2 hops                → 50%
//   • 3+ hops / unreachable → 25%
//
// Edges fade with whichever endpoint sits further from the focus.
//
// BFS is undirected — "first-degree neighbour" matches the social-graph
// meaning, independent of edge arrow direction (BPMN sequenceFlow
// shows arrows visually but a downstream step is just as related to a
// focused upstream step as the other way around).

interface NodeLike {
  id: string;
}

interface LinkLike {
  source: string;
  target: string;
}

/**
 * BFS depth from `centerId` over the undirected graph. The center
 * itself maps to 0. Nodes unreachable from the center are absent
 * from the returned map (callers should treat absence as
 * "far away" → 25% opacity).
 */
export function computeDepthFromCenter<N extends NodeLike, L extends LinkLike>(
  nodes: N[],
  links: L[],
  centerId: string | null | undefined,
): Map<string, number> {
  const depth = new Map<string, number>();
  if (!centerId) return depth;
  // Only consider links whose endpoints are present in the node set —
  // a perspective may filter out lifecycles or types, and a phantom
  // edge to a hidden node shouldn't shrink the apparent radius.
  const validIds = new Set(nodes.map((n) => n.id));
  if (!validIds.has(centerId)) return depth;

  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    if (!validIds.has(link.source) || !validIds.has(link.target)) continue;
    const sourceList = adjacency.get(link.source) ?? [];
    sourceList.push(link.target);
    adjacency.set(link.source, sourceList);
    const targetList = adjacency.get(link.target) ?? [];
    targetList.push(link.source);
    adjacency.set(link.target, targetList);
  }

  const queue: string[] = [centerId];
  depth.set(centerId, 0);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const here = depth.get(id) as number;
    for (const next of adjacency.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, here + 1);
      queue.push(next);
    }
  }
  return depth;
}

/**
 * The opacity to apply to a node at `depth` hops from the focal node.
 * `undefined` means "unreachable" and gets the deepest fade.
 *
 * Depth 0 is the focal node itself. Each outer degree fades further
 * so direct context remains prominent without turning the rest of the
 * canvas into visual noise.
 */
export function opacityForDepth(depth: number | undefined): number {
  if (depth === undefined) return 0.25;
  if (depth <= 0) return 1;
  if (depth === 1) return 0.75;
  if (depth === 2) return 0.5;
  return 0.25;
}

/**
 * The opacity to apply to an edge whose endpoints are at `from` and
 * `to` hops from the focal node. We pick the deeper of the two so
 * the edge to a faded node fades along with that node — an edge
 * never visually outshines its dimmer endpoint.
 */
export function opacityForEdge(from: number | undefined, to: number | undefined): number {
  const a = opacityForDepth(from);
  const b = opacityForDepth(to);
  return Math.min(a, b);
}

// Doubles the stroke weight of the focal node's incident edges to match
// the focal node's doubled border, so the "lines coming in and out" of the
// selected node read as part of the same emphasis.
const FOCAL_EDGE_WIDTH_MULTIPLIER = 2;

/**
 * Stroke width for an edge given the current focal node. Edges incident
 * to the focal node (one endpoint === `centerId`) are scaled by the focal
 * multiplier; every other edge — and every edge when no focal node is
 * set — keeps `baseWidth`.
 */
export function focalEdgeWidth(
  source: string,
  target: string,
  centerId: string | null | undefined,
  baseWidth: number,
): number {
  if (!centerId) return baseWidth;
  if (source === centerId || target === centerId) return baseWidth * FOCAL_EDGE_WIDTH_MULTIPLIER;
  return baseWidth;
}

/**
 * `null` when no focal node is set — callers can short-circuit the
 * per-node className/style work and render at full opacity.
 */
export function hasFocalNode(centerId: string | null | undefined, nodes: NodeLike[]): boolean {
  if (!centerId) return false;
  return nodes.some((n) => n.id === centerId);
}

/**
 * Treat any depth ≥ this as "far away" for layout — collapsed into a
 * single outermost ring. Opacity is allowed to be stricter than layout;
 * today 3+ hops all render at 25%, while depth 3 still keeps its own
 * ring so the graph does not jump when this visual fade changes.
 */
export const FAR_DEPTH = 4;

/**
 * Bucket a node's BFS depth into a small set of "rings":
 *   0 → focal node itself
 *   1, 2, 3 → first/second/third-degree neighbours
 *   FAR_DEPTH → everything 4+ hops away OR unreachable
 *
 * Callers use this to lay out concentric rings around the focal node:
 * one ring per bucket, growing outward.
 */
export function depthBucket(depth: number | undefined): number {
  if (depth === undefined) return FAR_DEPTH;
  if (depth >= FAR_DEPTH) return FAR_DEPTH;
  return depth;
}
