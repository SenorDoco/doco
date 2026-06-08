import type { GraphReferenceItem } from "./graph-references";
import { computeExternalNeighbours } from "./process-boundary";
import type { ProcessLane, ProcessNode, ProcessPool } from "./process-perspective.server";

/** A sequence-flow edge, minimal shape needed to find cross-pool neighbours. */
interface ReferenceLink {
  source: string;
  target: string;
  edge_type: string;
}

/**
 * Compare two nodes by creation order — the stable, append-only order the
 * BPMN numbering uses. `created_at` (an ISO timestamp) sorts chronologically;
 * ties (and rows with no timestamp) fall back to the id, which is itself
 * creation-ordered (a ULID) and always unique. A newly created node therefore
 * always sorts last, so it draws the next free number without disturbing any
 * existing one.
 */
function compareCreationOrder(a: ProcessNode, b: ProcessNode): number {
  const at = a.created_at ?? "";
  const bt = b.created_at ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/**
 * The "#N" numbering for the BPMN canvas — a stable property of the focal
 * **process**, not of whatever is currently on screen.
 *
 * The numbers belong to the process in focus (`focalPoolIds`): its pool
 * header(s) first, then each principal-owned swimlane, then every node that
 * belongs to the pool — *of every lifecycle* — in creation order. The basis
 * is the process's **full membership** (the unfiltered node set the server
 * always delivers, retired included), never the rendered/filtered subset. So:
 *
 *   • Retiring, hiding, or lifecycle-filtering a node leaves it in the
 *     membership (only its lifecycle flag or on-screen visibility changes),
 *     so every number stays put — the node keeps its #N, its badge simply
 *     stops rendering.
 *   • Adding a node extends the set by one; it sorts last (newest
 *     `created_at`) and takes the next free number, disturbing nothing.
 *   • Panning/zooming touches neither membership nor focus, so the numbers
 *     never move — which is also why this takes no viewport and no layout.
 *   • The numbering is recomputed from scratch only when a different process
 *     comes into focus (`focalPoolIds` changes).
 *
 * The canvas also draws the focal pool's cross-pool sequence-flow neighbours
 * as boxes OUTSIDE the pool (a node in another process that flows into or out
 * of this one — see process-boundary). They look like every other box on the
 * canvas, so they earn a #N too — appended after the focal members, in
 * creation order, from the full membership so the numbers stay stable under
 * pan/zoom/filter (a hidden neighbour keeps its number; its badge just doesn't
 * render). A node that is both an entry and an exit neighbour is one number.
 * The same node, focused, renders its OWN pool and is numbered as a member
 * there — the cross-pool number is this view's, recomputed when focus changes.
 *
 * An out-of-pool node with NO sequence flow crossing into focus is never drawn
 * on this canvas, so it is never numbered here.
 *
 * The Unassigned pool (no `process_id`) and the synthetic bands / catch-all
 * lanes (any non-`actor` kind) have no single owning node, so they get no
 * number. The overall cap (MAX_GRAPH_REFERENCES) is applied downstream by
 * `usePublishedReferences`, the single chokepoint every perspective
 * publishes through.
 */
export function processReferences(
  pools: ProcessPool[],
  lanes: ProcessLane[],
  nodes: ProcessNode[],
  links: readonly ReferenceLink[],
  focalPoolIds: ReadonlySet<string>,
  docoHandle: string | null | undefined,
): GraphReferenceItem[] {
  const items: GraphReferenceItem[] = [];
  for (const pool of pools) {
    if (!focalPoolIds.has(pool.id) || !pool.process_id) continue;
    items.push({
      number: items.length + 1,
      id: pool.process_id,
      entity_type: "action",
      label: pool.label,
      lifecycle: pool.lifecycle ?? "active",
      href: docoHandle ? `/${docoHandle}/action/${pool.process_id}` : null,
    });
  }
  for (const lane of lanes) {
    if (!focalPoolIds.has(lane.pool_id) || lane.kind !== "actor") continue;
    items.push({
      number: items.length + 1,
      id: lane.id,
      entity_type: "principal",
      label: lane.label,
      lifecycle: lane.lifecycle ?? "active",
      href: null,
    });
  }
  const members = nodes.filter((node) => focalPoolIds.has(node.pool_id)).sort(compareCreationOrder);
  for (const node of members) {
    items.push({
      number: items.length + 1,
      id: node.id,
      entity_type: node.entity_type,
      label: node.name ?? node.id,
      lifecycle: node.lifecycle ?? "active",
      href: node.href ?? null,
    });
  }
  // The cross-pool neighbour boxes drawn outside the pool. Dedupe by node id
  // (a node can be both an entry and an exit neighbour) and append in creation
  // order, after the members.
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const neighbourIds = new Set(
    computeExternalNeighbours(focalPoolIds, nodes, links).map((neighbour) => neighbour.id),
  );
  const neighbours = [...neighbourIds]
    .map((id) => nodeById.get(id))
    .filter((node): node is ProcessNode => node !== undefined)
    .sort(compareCreationOrder);
  for (const node of neighbours) {
    items.push({
      number: items.length + 1,
      id: node.id,
      entity_type: node.entity_type,
      label: node.name ?? node.id,
      lifecycle: node.lifecycle ?? "active",
      href: node.href ?? null,
    });
  }
  return items;
}
