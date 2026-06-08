// Top-level (root) process selection for the BPMN perspective's home view.
//
// The BPMN perspective opens on a directory of the Doco's *top-level
// processes* — the processes a viewer can drill into as entry points. What
// makes a process top-level is a single authoritative signal: the author
// marked its Action with the `top_level_process` flag (the same flag that
// exempts a root Action from the membership floor in the process template).
// "Top-level" is therefore a deliberate declaration, not a structural
// accident — a parentless Action the author never flagged (a drafting sketch,
// an orphan, a step missing its `has_parent` link) is NOT a top-level process
// and does not belong in this directory.
//
// Pure (no React / React Flow) so it unit-tests cleanly.

import type { ProcessPool } from "./process-perspective.server";

/**
 * The process pools the author declared top-level — every pool whose Action
 * carries the `top_level_process` flag (surfaced onto the pool by the loader).
 * Returned in the given pool order; the Unassigned pool (`process_id === null`)
 * is never flagged, so it never appears here.
 */
export function topLevelProcessPools(pools: readonly ProcessPool[]): ProcessPool[] {
  return pools.filter((p) => p.top_level_process === true);
}
