// Top-level (root) process selection for the BPMN perspective's home view.
//
// The BPMN perspective opens on a list of the Doco's *top-level processes*
// — the processes a viewer can drill into as entry points. A process is an
// Action with `has_parent` children; it is a *sub-process* when it is
// itself a member of another process (it has its own `has_parent` parent,
// so the server emits it as a member node). A top-level process is one that
// is no one's sub-process, so it stands on its own rather than nested
// inside another process's pool.
//
// Pure (no React / React Flow) so it unit-tests cleanly.

import type { ProcessNode, ProcessPool } from "./process-perspective.server";

/**
 * The process pools that are top-level — every pool whose process Action is
 * not itself a member of any pool. A sub-process Action *is* emitted as a
 * member node (it has a parent), so its id appears in `nodes` and its pool
 * drops out of this list. A top-level process Action is only ever a pool
 * header (never a member), so its id is absent from `nodes`. Returned in
 * the given pool order; the Unassigned pool (`process_id === null`) is never
 * top-level.
 */
export function topLevelProcessPools(
  pools: readonly ProcessPool[],
  nodes: readonly ProcessNode[],
): ProcessPool[] {
  const memberIds = new Set<string>();
  for (const node of nodes) memberIds.add(node.id);
  return pools.filter((p) => p.process_id !== null && !memberIds.has(p.process_id));
}
