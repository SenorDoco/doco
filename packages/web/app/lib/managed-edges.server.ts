// Reconcile the first-class edges a node projects from its relationship fields
// (option (i): edges as the authored source of truth). Runs inside the capture
// transaction so the node write and its projected edges commit atomically.
//
// Only the five promoted-column relations are managed here (see
// MANAGED_RELATION_EDGE_TYPES); every other relationship stays a node field for
// now. Edges authored directly via the edges API (origin='authored') are never
// touched — reconciliation owns origin='field' edges only.

import {
  type PoolClient,
  createChangeset,
  createEdge,
  retireEdge,
  withTransaction,
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
 * open transaction. No-op for non-node entities (policies carry none of the
 * five fields). Idempotent — re-capturing identical data creates and retires
 * nothing, and skips opening a changeset, so a full backfill never churns
 * edge history.
 */
export async function reconcileNodeEdges(
  c: PoolClient,
  args: { docoId: string; entityType: string; entity: Entity; actor: string | null },
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
    source: "api",
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
      origin: "field",
      actor: args.actor,
    });
  }
  for (const id of plan.toRetireIds) {
    await retireEdge(c, txId, { id, actor: args.actor });
  }
  return { created: plan.toCreate.length, retired: plan.toRetireIds.length };
}

/** Node types that own at least one of the five managed relationship fields. */
const MANAGED_OWNER_NODE_TYPES: readonly string[] = ["intent", "decision", "action", "log"];

/**
 * One-time backfill: project the managed relationship edges for every existing
 * node in a Doco (run per Doco by an operator after deploying the column drop).
 * Reuses the capture-path reconciliation, so it is idempotent — safe to re-run
 * and a no-op once every node's edges exist. Edge ids are ULIDs minted via
 * createEdge, which is why this is an app step rather than a SQL migration
 * (cf. #678's operator-run VALIDATE CONSTRAINT follow-up).
 */
export async function backfillManagedEdges(
  docoId: string,
): Promise<{ scanned: number; created: number; retired: number }> {
  return withTransaction(async (c) => {
    const { rows } = await c.query<{
      id: string;
      node_type: string;
      data: Record<string, unknown> | null;
    }>(
      `SELECT id, node_type, data
         FROM nodes
        WHERE doco_id = $1 AND node_type = ANY($2::text[])
        ORDER BY created_at`,
      [docoId, [...MANAGED_OWNER_NODE_TYPES]],
    );
    let created = 0;
    let retired = 0;
    for (const row of rows) {
      const res = await reconcileNodeEdges(c, {
        docoId,
        entityType: row.node_type,
        entity: { ...(row.data ?? {}), id: row.id } as unknown as Entity,
        actor: null,
      });
      created += res.created;
      retired += res.retired;
    }
    return { scanned: rows.length, created, retired };
  });
}
