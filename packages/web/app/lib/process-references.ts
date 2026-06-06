import type { GraphReferenceItem } from "./graph-references";
import type { ProcessLane, ProcessNode, ProcessPool } from "./process-perspective.server";

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
 * **Intent**, not of whatever is currently on screen.
 *
 * The numbers belong to the Intent in focus (`focalPoolIds`): its pool
 * header(s) first, then each principal-owned swimlane, then every node that
 * belongs to the pool — *of every lifecycle* — in creation order. The basis
 * is the Intent's **full membership** (the unfiltered node set the server
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
 *   • The numbering is recomputed from scratch only when a different Intent
 *     comes into focus (`focalPoolIds` changes).
 *
 * Nodes, lanes, and pools outside the focal Intent are never numbered: a
 * cross-intent neighbour drawn for context earns its number when *its* Intent
 * is the focus, not a borrowed one here.
 *
 * The Unassigned pool (no `intent_id`) and the synthetic bands / catch-all
 * lanes (any non-`actor` kind) have no single owning node, so they get no
 * number. The overall cap (MAX_GRAPH_REFERENCES) is applied downstream by
 * `usePublishedReferences`, the single chokepoint every perspective
 * publishes through.
 */
export function processReferences(
  pools: ProcessPool[],
  lanes: ProcessLane[],
  nodes: ProcessNode[],
  focalPoolIds: ReadonlySet<string>,
  docoHandle: string | null | undefined,
): GraphReferenceItem[] {
  const items: GraphReferenceItem[] = [];
  for (const pool of pools) {
    if (!focalPoolIds.has(pool.id) || !pool.intent_id) continue;
    items.push({
      number: items.length + 1,
      id: pool.intent_id,
      entity_type: "intent",
      label: pool.label,
      lifecycle: pool.lifecycle ?? "active",
      href: docoHandle ? `/${docoHandle}/intent/${pool.intent_id}` : null,
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
  return items;
}
