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
