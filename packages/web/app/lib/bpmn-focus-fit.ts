const POOL_HEADER_PREFIX = "pool-header:";

export interface FocusFitLane {
  id: string;
  pool_id: string;
}

/**
 * The flow-node ids whose combined bounding box the BPMN cold-open /
 * default focus should fit when it lands on a pool.
 *
 * A pool's focus target resolves to its header band (`pool-header:<id>`) —
 * a full-width strip at the very top of the pool. Fitting that one node
 * strands the pool in empty canvas: the header centers vertically with
 * nothing above it and the lanes pushed below. Instead, fit the header
 * PLUS every lane in the pool; together they span the pool's full width
 * and height, so the camera frames the entire process.
 *
 * Returns null when the target isn't a pool header — the caller then keeps
 * the single-node zoom-to-100% behavior used for ordinary step focus.
 */
export function bpmnPoolFitNodeIds(
  targetFlowNodeId: string,
  lanes: readonly FocusFitLane[],
  laneFlowNodeId: (laneId: string) => string,
  renderedFlowNodeIds: ReadonlySet<string>,
): string[] | null {
  if (!targetFlowNodeId.startsWith(POOL_HEADER_PREFIX)) return null;
  const poolId = targetFlowNodeId.slice(POOL_HEADER_PREFIX.length);
  const ids = [targetFlowNodeId];
  for (const lane of lanes) {
    if (lane.pool_id === poolId) ids.push(laneFlowNodeId(lane.id));
  }
  return ids.filter((id) => renderedFlowNodeIds.has(id));
}

/**
 * The flow node the BPMN camera should frame for a given focus target.
 *
 * An *Intent* focus frames the whole pool: it resolves to that pool's header
 * (`pool-header:<id>`), which `bpmnPoolFitNodeIds` then expands to header +
 * lanes so the camera sees the entire process — not just its entry step. A
 * non-Intent (node) focus frames that node. Returns null when neither the
 * Intent's pool header nor the node is currently rendered.
 */
export function bpmnFocusFlowNodeId(
  target: string,
  poolIdByIntentId: ReadonlyMap<string, string>,
  renderedFlowNodeIds: ReadonlySet<string>,
): string | null {
  const poolId = poolIdByIntentId.get(target);
  if (poolId) {
    const headerId = `${POOL_HEADER_PREFIX}${poolId}`;
    if (renderedFlowNodeIds.has(headerId)) return headerId;
  }
  if (renderedFlowNodeIds.has(target)) return target;
  return null;
}
