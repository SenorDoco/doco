// Sub-process (drill-down) detection for the BPMN perspective.
//
// In BPMN a *collapsed sub-process* is an activity that stands in for a
// whole nested process — drawn as a task with a small "+" marker. In a
// Doco that now maps onto an Action that is *itself a process*: it has one
// or more flow nodes pointing at it with a `has_parent` edge (its
// members). Such an Action renders as an ordinary member of its parent's
// pool but can be expanded into its own pool — there is no longer a
// separate "calling Action ↔ purpose Intent" pairing.
//
// This module is the pure selection rule, deliberately free of React /
// React Flow imports so it can be unit-tested and shared by the renderer
// without dragging the canvas bundle into a test runner.

export interface SubprocessCandidate {
  id: string;
  node_type: string;
  /** True when this node is itself a process — an Action with `has_parent`
   *  children. Only such a node carries the collapsed-subprocess affordance. */
  is_process?: boolean;
}

/**
 * The pool a node expands into when it is a sub-process, or null when it is
 * an ordinary step. Only Actions qualify — the BPMN collapsed-subprocess
 * marker is an *activity* glyph, so gateways (Decisions) and milestones
 * (States) never carry it even if some child points at them. The expansion
 * target is deterministically `pool:<id>`: the node's own process pool.
 */
export function subprocessPoolId(node: SubprocessCandidate): string | null {
  if (node.node_type !== "action") return null;
  if (!node.is_process) return null;
  return `pool:${node.id}`;
}
