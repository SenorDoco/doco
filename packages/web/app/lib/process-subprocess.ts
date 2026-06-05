// Sub-process (drill-down) detection for the BPMN perspective.
//
// In BPMN a *collapsed sub-process* is an activity that stands in for a
// whole nested process — drawn as a task with a small "+" marker. In a
// Doco that maps onto an Action whose `serves` edge points at an
// Intent *other than its own pool's*: the Action is laid out inside its
// primary Intent's pool, but it also advances a second Intent that is
// itself a process (with its own pool). The renderer surfaces that as a
// BPMN "+" marker on the Action plus a dashed link up to the
// sub-process Intent's pool header.
//
// This module is the pure selection rule, deliberately free of React /
// React Flow imports so it can be unit-tested and shared by the
// renderer without dragging the canvas bundle into a test runner.

export interface SubprocessCandidate {
  entity_type: string;
  /** The pool the node is laid out in: `pool:<intent_id>`. */
  pool_id: string;
  /** Every Intent this node `serves`. The primary one (highest
   *  PageRank) is its `pool_id`; the rest are sub-process candidates. */
  served_intent_ids?: string[];
}

/**
 * The Intents an Action drills into as sub-processes: every Intent it
 * `serves` that (a) isn't the Action's own pool and (b) has a pool
 * actually rendered on the current canvas. Order follows the served Intent ids;
 * duplicates are dropped.
 *
 * Only Actions qualify. The BPMN "+" collapsed-subprocess marker is an
 * *activity* glyph, so gateways (Decisions) and other shapes never
 * carry it even when they serve multiple Intents. Restricting to
 * rendered pools keeps the rule honest: we only draw a drill-down link
 * to a sub-process the viewer can actually see.
 */
export function subprocessTargetIntents(
  node: SubprocessCandidate,
  renderedIntentPools: ReadonlySet<string>,
): string[] {
  if (node.entity_type !== "action") return [];
  const served = node.served_intent_ids;
  if (!served || served.length === 0) return [];
  const homeIntent = node.pool_id.startsWith("pool:") ? node.pool_id.slice("pool:".length) : null;
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const intentId of served) {
    if (intentId === homeIntent) continue;
    if (!renderedIntentPools.has(intentId)) continue;
    if (seen.has(intentId)) continue;
    seen.add(intentId);
    targets.push(intentId);
  }
  return targets;
}
