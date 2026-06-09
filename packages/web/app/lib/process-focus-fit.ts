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
 * The pool header the camera should frame for a *drilled-in* process — picking
 * a process from the overview, or the "View subprocess" affordance opening a
 * subprocess into its OWN pool. The caller pairs this with the pool header →
 * `processPoolFitNodeIds` so the whole pool (header + lanes) is framed.
 *
 * Returns null when nothing is expanded (`expandedProcessId` is null), when the
 * process heads no pool, or when that pool's header isn't rendered yet (the
 * caller retries once the layout catches up).
 */
export function processExpansionFitNodeId(
  expandedProcessId: string | null,
  poolIdByProcessId: ReadonlyMap<string, string>,
  renderedFlowNodeIds: ReadonlySet<string>,
): string | null {
  if (!expandedProcessId) return null;
  const poolId = poolIdByProcessId.get(expandedProcessId);
  if (!poolId) return null;
  const headerId = `${POOL_HEADER_PREFIX}${poolId}`;
  return renderedFlowNodeIds.has(headerId) ? headerId : null;
}

/** What the BPMN camera should frame right now, plus a key identifying it. */
export interface ProcessCameraFit {
  /**
   * Stable identity of the current camera target. The controller re-fits
   * exactly when this changes from the last applied key, so navigating (home,
   * a drill-in, a focus) re-frames while a plain re-render (pan/zoom, an
   * unrelated state update) leaves it untouched.
   */
  key: string;
  /** The flow node to frame, or null to fit the whole canvas (degenerate home). */
  target: string | null;
}

/**
 * The single camera rule for the BPMN perspective: what the viewport should
 * frame right now. This collapses the four one-shot guards it replaces (mount /
 * default / URL focus / expansion — each reset on a different navigation path,
 * which is why Home-after-drill-in and revisiting a process used to skip the
 * re-fit) into one keyed decision. The caller fits whenever `key` changes and
 * never otherwise.
 *
 * Priority, highest first:
 *   • home (the overview) — frame the whole synthetic top-level pool, or fit the
 *     whole canvas when the Doco has no top-level pool to frame;
 *   • a freshly drilled-in pool (`expandedPoolHeaderId`) — frame that pool, even
 *     when no URL focus changed (overview → process is a focus-less drill-in);
 *   • the URL / default focus node (`focusFlowNodeId`) — frame that node.
 *
 * A revalidation or lifecycle-filter change (`fitResetKey`) re-frames to the
 * cold-start fit — but only while NOT holding a URL/agent focus (`urlFocused`),
 * which must keep its framing. It folds into the same key, so the one rule
 * covers it: when focused, the reset is invisible to the key.
 *
 * Returns null when nothing is laid out to frame yet — the caller retries once
 * React Flow renders the target.
 */
export function processCameraFitTarget(input: {
  homeMode: boolean;
  homePoolHeaderId: string | null;
  expandedPoolHeaderId: string | null;
  focusFlowNodeId: string | null;
  urlFocused: boolean;
  fitResetKey?: string;
}): ProcessCameraFit | null {
  const reset = input.urlFocused ? "" : `|reset:${input.fitResetKey ?? ""}`;
  if (input.homeMode) {
    return {
      key: `${input.homePoolHeaderId ?? "home:all"}${reset}`,
      target: input.homePoolHeaderId,
    };
  }
  const target = input.expandedPoolHeaderId ?? input.focusFlowNodeId;
  return target ? { key: `${target}${reset}`, target } : null;
}
