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
export function processPoolFitNodeIds(
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
 * (`pool-header:<id>`), which `processPoolFitNodeIds` then expands to header +
 * lanes so the camera sees the entire process — not just its entry step. A
 * non-Intent (node) focus frames that node. Returns null when neither the
 * Intent's pool header nor the node is currently rendered.
 */
export function processFocusFlowNodeId(
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

/**
 * The pool header the camera should re-frame when a process is *freshly
 * expanded* — drilling into a process from the overview, or the "View
 * subprocess" affordance opening a subprocess into its OWN pool.
 *
 * This is distinct from the one-shot initial/URL focus. That fit fires once
 * (per target, or once for the default browse) so a plain node click can't
 * yank the camera; but a deliberate drill-in is a "frame this pool" gesture
 * that must move the camera EVERY time, even after the default fit is spent.
 * The caller pairs this with the pool header → `processPoolFitNodeIds` so the
 * whole pool (header + lanes) is framed.
 *
 * Returns null when:
 *   • nothing is expanded (`expandedProcessId` is null) — camera stays put;
 *   • the expansion merely mirrors the current URL focus
 *     (`expandedProcessId === initialFocusId`) — the cold-open path already
 *     frames that pool, so re-fitting here would just double up;
 *   • the process heads no pool, or that pool's header isn't rendered yet —
 *     the caller retries once the layout catches up.
 */
export function processExpansionFitNodeId(
  expandedProcessId: string | null,
  initialFocusId: string | null,
  poolIdByProcessId: ReadonlyMap<string, string>,
  renderedFlowNodeIds: ReadonlySet<string>,
): string | null {
  if (!expandedProcessId || expandedProcessId === initialFocusId) return null;
  const poolId = poolIdByProcessId.get(expandedProcessId);
  if (!poolId) return null;
  const headerId = `${POOL_HEADER_PREFIX}${poolId}`;
  return renderedFlowNodeIds.has(headerId) ? headerId : null;
}
