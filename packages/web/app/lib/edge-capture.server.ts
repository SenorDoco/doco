// Edge authoring. The web entry point for creating and
// retiring FIRST-CLASS edges. Every mutation goes through the append-only
// commit() boundary (changeset + immutable version snapshot), so edges get
// their own id, lifecycle, provenance, and history — peers of nodes.
//
// Package-only imports (no ~ alias) so this is unit-testable outside the
// react-router runtime (see scripts/edge-capture-test.ts).

import {
  type CommitSource,
  type EdgeRow,
  type EntityRecord,
  createChangeset,
  createEdge,
  getEntity,
  retireEdge,
  withClient,
  withTransaction,
} from "@doco/db";
import {
  EDGE_ENDPOINT_TYPES,
  EDGE_TYPES,
  NODE_TYPES,
  isEntityId,
  parseEntityId,
} from "@doco/shared";
import { runEdgeAuthoringPolicies } from "./authoring-runner.server";

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);
const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

export interface CaptureEdgeInput {
  docoId: string;
  actorId: string | null;
  edgeType: string;
  fromId: string;
  toId: string;
  props?: Record<string, unknown> | null;
  lifecycle?: "drafting" | "active";
  reason?: string | null;
  source?: CommitSource;
  metadata?: Record<string, unknown> | null;
}

export type EdgeCaptureResult =
  | { ok: true; id: string; path: string; edge: EdgeRow; footer_lines: string[] }
  | { error: string; status: number };

async function resolveEndpoint(
  docoId: string,
  id: string,
): Promise<{ ok: true; type: string; rec: EntityRecord } | { error: string }> {
  if (!isEntityId(id)) return { error: "is not a valid entity id" };
  const parsed = parseEntityId(id);
  if (!parsed) return { error: "is not a valid entity id" };
  const rec = await getEntity(parsed.type, id);
  if (!rec || rec.doco_id !== docoId) return { error: "does not exist in this Doco" };
  return { ok: true, type: parsed.type, rec };
}

/**
 * Flatten an endpoint node into the fields an edge-policy judge needs: its
 * `name`, its prose `text`, and its structured `data`. Keyed by node type
 * (e.g. `action`, `intent`) so a policy spec can reference each endpoint by
 * the role it plays in the edge.
 */
function endpointPayload(rec: EntityRecord): Record<string, unknown> {
  return {
    name: rec.name ?? null,
    text: rec.type_named_value ?? null,
    ...(rec.data && typeof rec.data === "object" ? rec.data : {}),
  };
}

/** Create a first-class edge through the commit() boundary. */
export async function captureEdge(input: CaptureEdgeInput): Promise<EdgeCaptureResult> {
  if (!EDGE_TYPE_SET.has(input.edgeType)) {
    return {
      error: `Unknown edge_type '${input.edgeType}'. Valid: ${EDGE_TYPES.join(", ")}.`,
      status: 400,
    };
  }
  if (input.fromId === input.toId) {
    return { error: "from_id and to_id must differ (no self-edges).", status: 400 };
  }
  const from = await resolveEndpoint(input.docoId, input.fromId);
  if ("error" in from) return { error: `from_id ${from.error}.`, status: 400 };
  const to = await resolveEndpoint(input.docoId, input.toId);
  if ("error" in to) return { error: `to_id ${to.error}.`, status: 400 };

  // Edges connect graph nodes only. Workspace/doco containment rides on the
  // doco_id / workspace_id columns, never on a graph edge; a policy is governance
  // config, not a node. The `edges.from_id` / `edges.to_id` → nodes(id) FKs
  // enforce this in the DB — this check fails fast with a clear message
  // instead of surfacing a raw FK violation.
  if (!NODE_TYPE_SET.has(from.type)) {
    return {
      error: `from_id must be a node, not a ${from.type} (edges connect nodes only).`,
      status: 400,
    };
  }
  if (!NODE_TYPE_SET.has(to.type)) {
    return {
      error: `to_id must be a node, not a ${to.type} (edges connect nodes only).`,
      status: 400,
    };
  }

  // Endpoint node-type enforcement for canonical edge families whose shape is
  // unambiguous. Broad families absent from the map accept any endpoints.
  const endpoints = EDGE_ENDPOINT_TYPES[input.edgeType];
  if (endpoints?.from && !endpoints.from.includes(from.type as never)) {
    return {
      error: `A '${input.edgeType}' edge must start from ${endpoints.from.join(" or ")} (got ${from.type}).`,
      status: 400,
    };
  }
  if (endpoints?.to && !endpoints.to.includes(to.type as never)) {
    return {
      error: `A '${input.edgeType}' edge must point at ${endpoints.to.join(" or ")} (got ${to.type}).`,
      status: 400,
    };
  }

  // Edge-scoped authoring policies — LLM-judged checks that compare the two
  // endpoints (e.g. a sub-process child Intent's name must be the base form of
  // the calling Action it `serves`). A `drafting` edge is a sketch and exempt,
  // mirroring the node lifecycle exemption; committed (`active`) edges are held
  // to the policy.
  const role = typeof input.props?.role === "string" ? input.props.role : null;
  if ((input.lifecycle ?? "active") !== "drafting") {
    const pred = await runEdgeAuthoringPolicies({
      docoId: input.docoId,
      edge: {
        edge_type: input.edgeType,
        role,
        from_node_type: from.type,
        to_node_type: to.type,
      },
      judgeCandidate: {
        id: `${input.fromId}->${input.toId}`,
        edge_type: input.edgeType,
        role,
        [from.type]: endpointPayload(from.rec),
        [to.type]: endpointPayload(to.rec),
      },
    });
    if (pred.blocking) {
      return { error: pred.blocking.reason, status: 422 };
    }
  }

  try {
    const edge = await withTransaction(async (c) => {
      const txId = await createChangeset(c, {
        docoId: input.docoId,
        actor: input.actorId,
        source: input.source ?? "api",
        metadata: input.metadata ?? null,
        reason: input.reason ?? null,
      });
      return createEdge(c, txId, {
        docoId: input.docoId,
        edgeType: input.edgeType,
        fromId: input.fromId,
        fromNodeType: from.type,
        toId: input.toId,
        toNodeType: to.type,
        props: input.props ?? null,
        lifecycle: input.lifecycle ?? "active",
        actor: input.actorId,
      });
    });
    return {
      ok: true,
      id: edge.id,
      path: `/api/edges/${edge.id}.json`,
      edge,
      footer_lines: [
        `edge ${edge.id} created (${input.edgeType}: ${input.fromId} → ${input.toId})`,
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/edges_live_uniq|duplicate key/.test(msg)) {
      return {
        error: `A live '${input.edgeType}' edge already exists between these nodes.`,
        status: 409,
      };
    }
    return { error: msg, status: 500 };
  }
}

/** Read one edge in a Doco (current-state projection). */
export async function getEdgeById(docoId: string, id: string): Promise<EdgeRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<EdgeRow>("SELECT * FROM edges WHERE id = $1 AND doco_id = $2", [
      id,
      docoId,
    ]);
    return rows[0] ?? null;
  });
}

/**
 * Whether a live (non-retired) edge of `edgeType` already connects from→to in
 * the Doco. Role metadata participates in identity for broad canonical edge
 * families.
 */
export async function edgeExists(
  docoId: string,
  edgeType: string,
  fromId: string,
  toId: string,
  role?: string | null,
): Promise<boolean> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ x: number }>(
      `SELECT 1 AS x FROM edges
        WHERE doco_id = $1 AND edge_type = $2 AND from_id = $3 AND to_id = $4
          AND COALESCE(props->>'role', '') = COALESCE($5, '')
          AND lifecycle <> 'retired'
        LIMIT 1`,
      [docoId, edgeType, fromId, toId, role ?? null],
    );
    return rows.length > 0;
  });
}

export type EdgeRetireResult =
  | { ok: true; id: string; edge: EdgeRow; footer_lines: string[] }
  | { error: string; status: number };

/** Retire an edge (the only "delete") through the commit() boundary. */
export async function retireEdgeRequest(input: {
  docoId: string;
  actorId: string | null;
  id: string;
  reason?: string | null;
  source?: CommitSource;
  metadata?: Record<string, unknown> | null;
}): Promise<EdgeRetireResult> {
  const existing = await getEdgeById(input.docoId, input.id);
  if (!existing) return { error: `edge not found: ${input.id}`, status: 404 };
  if (existing.lifecycle === "retired") {
    return {
      ok: true,
      id: existing.id,
      edge: existing,
      footer_lines: [`edge ${existing.id} already retired`],
    };
  }
  const edge = await withTransaction(async (c) => {
    const txId = await createChangeset(c, {
      docoId: input.docoId,
      actor: input.actorId,
      source: input.source ?? "api",
      metadata: input.metadata ?? null,
      reason: input.reason ?? "retire edge",
    });
    return retireEdge(c, txId, { id: input.id, actor: input.actorId });
  });
  return { ok: true, id: edge.id, edge, footer_lines: [`edge ${edge.id} retired`] };
}
