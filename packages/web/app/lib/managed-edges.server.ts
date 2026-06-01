// Reconcile the first-class edges a node projects from its relationship fields
// (option (i): edges as the authored source of truth). Runs inside the capture
// transaction so the node write and its projected edges commit atomically.
//
// Every relation kind is managed here (see MANAGED_RELATION_EDGE_TYPES). Edges
// authored directly via the edges API (origin='authored') are never touched —
// reconciliation owns origin='field' edges only.

import {
  type CommitSource,
  type PoolClient,
  createChangeset,
  createEdge,
  retireEdge,
} from "@doco/db";
import {
  type ExistingManagedEdge,
  MANAGED_RELATION_EDGE_TYPES,
  managedEdges,
  reconcileManagedEdges,
} from "@doco/index";
import { type Entity, NODE_TYPES } from "@doco/shared";

const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);
const MANAGED_TYPES: readonly string[] = [...MANAGED_RELATION_EDGE_TYPES];

export interface ReconcileNodeEdgesResult {
  created: number;
  retired: number;
}

/**
 * Project + reconcile a node's managed relationship edges within the caller's
 * open transaction. No-op for non-node entities. Idempotent — re-capturing
 * identical data creates and retires
 * nothing, and skips opening a changeset, so a full backfill never churns
 * edge history.
 */
export async function reconcileNodeEdges(
  c: PoolClient,
  args: {
    docoId: string;
    entityType: string;
    entity: Entity;
    actor: string | null;
    source?: CommitSource;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ReconcileNodeEdgesResult> {
  if (!NODE_TYPE_SET.has(args.entityType)) return { created: 0, retired: 0 };

  const desired = managedEdges(args.entity);
  const { rows } = await c.query<{
    id: string;
    edge_type: string;
    to_id: string;
    origin: string;
  }>(
    `SELECT id, edge_type, to_id, origin
       FROM edges
      WHERE doco_id = $1 AND from_id = $2 AND lifecycle <> 'retired'
        AND edge_type = ANY($3::text[])`,
    [args.docoId, args.entity.id, MANAGED_TYPES],
  );
  const existing: ExistingManagedEdge[] = rows.map((r) => ({
    id: r.id,
    edge_type: r.edge_type,
    to_id: r.to_id,
    origin: r.origin === "field" ? "field" : "authored",
  }));

  const plan = reconcileManagedEdges(desired, existing);
  if (plan.toCreate.length === 0 && plan.toRetireIds.length === 0) {
    return { created: 0, retired: 0 };
  }

  const txId = await createChangeset(c, {
    docoId: args.docoId,
    actor: args.actor,
    source: args.source ?? "api",
    metadata: args.metadata ?? null,
    reason: "reconcile node relationship edges",
  });
  for (const e of plan.toCreate) {
    await createEdge(c, txId, {
      docoId: args.docoId,
      edgeType: e.edge_type,
      fromId: e.from_id,
      fromNodeType: e.from_node_type,
      toId: e.to_id,
      toNodeType: e.to_node_type,
      props: e.edge_props ?? null,
      origin: "field",
      actor: args.actor,
    });
  }
  for (const id of plan.toRetireIds) {
    await retireEdge(c, txId, { id, actor: args.actor });
  }
  return { created: plan.toCreate.length, retired: plan.toRetireIds.length };
}
