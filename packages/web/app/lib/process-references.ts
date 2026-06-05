import type { GraphReferenceItem } from "./graph-references";
import { compareReadingOrder } from "./perspective-references";
import type { ProcessLane, ProcessPool } from "./process-perspective.server";

/**
 * A rendered BPMN flow shape, reduced to what numbering needs: its
 * canvas position and height (for the reading-order sort). Positions are
 * the layout's canvas coordinates — never screen coordinates — so the
 * numbering never depends on the viewport.
 */
export interface ProcessNodeReference {
  id: string;
  entity_type: string;
  label: string;
  lifecycle: string | null;
  href: string | null;
  position: { x: number; y: number };
  height: number;
}

/**
 * The complete "#N" numbering for the BPMN canvas, in reading order:
 * the Intent pool header(s) first (the topmost bands), then each
 * principal-owned swimlane, then every rendered flow shape sorted by its
 * canvas position (top-to-bottom by row, then left-to-right).
 *
 * This is a pure function of the *rendered set and its layout* — it takes
 * no viewport. Unlike the Graph/org-tree perspectives (which renumber on
 * every pan so #N tracks on-screen reading order), the BPMN numbers are
 * fixed to the process: they shift only when a different Intent is brought
 * on-screen (the focal pool changes), never when the user pans or zooms.
 *
 * The Unassigned pool (no `intent_id`) and the synthetic bands /
 * catch-all lanes (any non-`actor` kind) have no single owning node, so
 * they get no number — same rule the lane numbering already followed.
 * The overall cap (MAX_GRAPH_REFERENCES) is applied downstream by
 * `usePublishedReferences`, the single chokepoint every perspective
 * publishes through.
 */
export function processReferences(
  pools: ProcessPool[],
  lanes: ProcessLane[],
  nodes: ProcessNodeReference[],
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
  const orderedNodes = [...nodes].sort((a, b) =>
    compareReadingOrder(
      { x: a.position.x, y: a.position.y, height: a.height, id: a.id },
      { x: b.position.x, y: b.position.y, height: b.height, id: b.id },
    ),
  );
  for (const node of orderedNodes) {
    items.push({
      number: items.length + 1,
      id: node.id,
      entity_type: node.entity_type,
      label: node.label,
      lifecycle: node.lifecycle,
      href: node.href,
    });
  }
  return items;
}
