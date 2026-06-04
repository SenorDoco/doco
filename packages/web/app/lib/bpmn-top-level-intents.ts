// Top-level (root) process selection for the BPMN perspective's home view.
//
// The BPMN perspective opens on a list of the Doco's *top-level processes*
// — the Intents a viewer can drill into as entry points. An Intent is a
// collapsed *sub-process* when some Action `serves` it from outside its own
// pool (the same rule that draws the BPMN "+" drill-down marker). A
// top-level Intent is one no Action invokes that way, so it stands on its
// own rather than nested inside another process's step.
//
// Pure (no React / React Flow) so it unit-tests cleanly and stays in lockstep
// with `subprocessTargetIntents`, the single source of truth for "what counts
// as a sub-process."

import type { BpmnNode, BpmnPool } from "./bpmn-perspective.server";
import { subprocessTargetIntents } from "./bpmn-subprocess";

/**
 * The Intent pools that are top-level processes — every pool with an Intent
 * that no Action drills into as a sub-process. Returned in the given pool
 * order; the Unassigned pool (`intent_id === null`) is never top-level.
 */
export function topLevelIntentPools(
  pools: readonly BpmnPool[],
  nodes: readonly BpmnNode[],
): BpmnPool[] {
  // Treat every Intent that has a pool as "rendered" so an Action's served
  // Intent demotes it regardless of which pool the focused canvas is showing.
  const intentIds = new Set<string>();
  for (const p of pools) if (p.intent_id) intentIds.add(p.intent_id);

  const subProcessIntentIds = new Set<string>();
  for (const node of nodes) {
    for (const intentId of subprocessTargetIntents(node, intentIds)) {
      subProcessIntentIds.add(intentId);
    }
  }

  return pools.filter((p) => p.intent_id !== null && !subProcessIntentIds.has(p.intent_id));
}
