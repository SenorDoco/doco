import type { BpmnLane, BpmnPool } from "./bpmn-perspective.server";
import type { GraphReferenceItem } from "./graph-references";

/**
 * Leading "#N" references for the BPMN canvas, in top-to-bottom reading
 * order: the Intent pool header(s) first (the topmost bands), then each
 * principal-owned swimlane below them. These are handed to
 * `usePerspectiveReferences` as `priorityItems`, so they take the first
 * numbers and every flow shape is numbered after them.
 *
 * The Unassigned pool (no `intent_id`) and the synthetic bands /
 * catch-all lanes (any non-`actor` kind) have no single owning node, so
 * they get no number — same rule the lane numbering already followed.
 */
export function bpmnPriorityReferences(
  pools: BpmnPool[],
  lanes: BpmnLane[],
  docoHandle: string | null | undefined,
): GraphReferenceItem[] {
  const items: GraphReferenceItem[] = [];
  for (const pool of pools) {
    if (!pool.intent_id) continue;
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
    if (lane.kind !== "actor") continue;
    items.push({
      number: items.length + 1,
      id: lane.id,
      entity_type: "principal",
      label: lane.label,
      lifecycle: lane.lifecycle ?? "active",
      href: null,
    });
  }
  return items;
}
