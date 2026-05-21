// Cross-Doco edge resolution. The edge derivation in `edges.ts` produces
// one edge per entity-ID-shaped field, regardless of which Doco the
// target lives in. This module bridges to Postgres to figure out where
// each target actually lives, applies the access rule, and returns the
// validated edge set that the indexer writes.
//
// Access rules (the user-facing contract behind this PR):
//   1) Same organization — both Docos share an `org_id`, OR
//   2) Target Doco is public — `visibility = 'public'`.
//
// Anything else is dropped (the orphan/unauthorized cross-Doco edge
// silently disappears from the materialized graph).

import { type DocoAccessRow, getDocosAccessInfo, lookupEntityDocos } from "@doco/db";
import type { Edge } from "./edges.js";

export type DocoAccess = DocoAccessRow;

export interface ResolvedEdge extends Edge {
  /** Always populated. Equals the source `doco_id` for intra-Doco edges. */
  to_doco_id: string;
}

/**
 * Pure access-rule check. Public so callers (and tests) can apply the
 * same policy outside the indexer (e.g., authorization for showing a
 * cross-Doco target in the graph view).
 */
export function canEmitCrossDocoEdge(from: DocoAccess, to: DocoAccess): boolean {
  if (from.id === to.id) return true;
  if (from.org_id !== null && from.org_id === to.org_id) return true;
  if (to.visibility === "public") return true;
  return false;
}

/**
 * Apply the cross-Doco access rule to a batch of derived edges. Pure
 * function over the pre-computed maps so it's trivially testable
 * without a database.
 *
 * Inputs:
 *   - `fromDoco`: access metadata for the source Doco.
 *   - `localEntityIds`: ids loaded with the source Doco (its own
 *     entities + host-level principals/orgs). Edges whose target is
 *     in this set are intra-Doco; they keep `to_doco_id = fromDoco.id`.
 *   - `edges`: every derived edge from the source Doco's entities.
 *   - `targetEntityDocos`: result of `lookupEntityDocos` for every
 *     edge target NOT in `localEntityIds` — maps target entity id to
 *     its owning Doco id.
 *   - `docoAccess`: result of `getDocosAccessInfo` for every Doco id
 *     in `targetEntityDocos.values()` plus `fromDoco.id`.
 *
 * Outputs: edges that pass the access check, with `to_doco_id` populated.
 * Orphan targets (not present in `targetEntityDocos`) and access-denied
 * cross-Doco edges are dropped.
 */
export function applyCrossDocoAccess(
  fromDoco: DocoAccess,
  localEntityIds: ReadonlySet<string>,
  edges: readonly Edge[],
  targetEntityDocos: ReadonlyMap<string, string>,
  docoAccess: ReadonlyMap<string, DocoAccess>,
): ResolvedEdge[] {
  const out: ResolvedEdge[] = [];
  for (const edge of edges) {
    if (localEntityIds.has(edge.to_id) || edge.to_id === fromDoco.id) {
      out.push({ ...edge, to_doco_id: fromDoco.id });
      continue;
    }
    const targetDocoId = targetEntityDocos.get(edge.to_id);
    if (!targetDocoId) continue; // orphan reference — target doesn't exist
    if (targetDocoId === fromDoco.id) {
      // Target lives in the source Doco but wasn't in localEntityIds
      // (e.g., a node type the loader doesn't track). Treat as local.
      out.push({ ...edge, to_doco_id: fromDoco.id });
      continue;
    }
    const targetAccess = docoAccess.get(targetDocoId);
    if (!targetAccess) continue; // doco-access lookup failed; drop defensively
    if (!canEmitCrossDocoEdge(fromDoco, targetAccess)) continue;
    out.push({ ...edge, to_doco_id: targetDocoId });
  }
  return out;
}

/**
 * Run the full cross-Doco resolution pipeline against Postgres. Walks
 * `edges`, batch-fetches docos for unknown targets, validates access,
 * and returns the resolved edge list. The orchestrator for the indexer.
 */
export async function resolveCrossDocoEdges(
  fromDoco: DocoAccess,
  localEntityIds: ReadonlySet<string>,
  edges: readonly Edge[],
): Promise<ResolvedEdge[]> {
  const foreignTargetIds = new Set<string>();
  for (const e of edges) {
    if (localEntityIds.has(e.to_id) || e.to_id === fromDoco.id) continue;
    foreignTargetIds.add(e.to_id);
  }
  if (foreignTargetIds.size === 0) {
    // No foreign targets — every edge is intra-Doco.
    return edges.map((e) => ({ ...e, to_doco_id: fromDoco.id }));
  }
  const targetEntityDocos = await lookupEntityDocos([...foreignTargetIds]);
  const targetDocoIds = new Set(targetEntityDocos.values());
  targetDocoIds.delete(fromDoco.id); // already have fromDoco
  const accessRows = await getDocosAccessInfo([...targetDocoIds]);
  const docoAccess = new Map<string, DocoAccess>(accessRows);
  docoAccess.set(fromDoco.id, fromDoco);
  return applyCrossDocoAccess(fromDoco, localEntityIds, edges, targetEntityDocos, docoAccess);
}
