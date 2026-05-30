// Edge authoring (doco-vnext). The web entry point for creating and
// retiring FIRST-CLASS edges. Every mutation goes through the append-only
// commit() boundary (changeset + immutable version snapshot), so edges get
// their own id, lifecycle, provenance, and history — peers of nodes.
//
// Package-only imports (no ~ alias) so this is unit-testable outside the
// react-router runtime (see scripts/edge-capture-test.ts).

import {
  type EdgeRow,
  createChangeset,
  createEdge,
  getEntity,
  retireEdge,
  withClient,
  withTransaction,
} from "@doco/db";
import { EDGE_ENDPOINT_TYPES, EDGE_TYPES, isEntityId, parseEntityId } from "@doco/shared";

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

export interface CaptureEdgeInput {
  docoId: string;
  actorId: string | null;
  edgeType: string;
  fromId: string;
  toId: string;
  props?: Record<string, unknown> | null;
  lifecycle?: "drafting" | "asserted";
  reason?: string | null;
}

export type EdgeCaptureResult =
  | { ok: true; id: string; path: string; edge: EdgeRow; footer_lines: string[] }
  | { error: string; status: number };

async function resolveEndpoint(
  docoId: string,
  id: string,
): Promise<{ ok: true; type: string } | { error: string }> {
  if (!isEntityId(id)) return { error: "is not a valid entity id" };
  const parsed = parseEntityId(id);
  if (!parsed) return { error: "is not a valid entity id" };
  const rec = await getEntity(parsed.type, id);
  if (!rec || rec.doco_id !== docoId) return { error: "does not exist in this Doco" };
  return { ok: true, type: parsed.type };
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

  // Endpoint node-type enforcement: a `serves` edge must point at an Intent,
  // `reports_to` must run Principal→Principal, etc. Keeps the graph free of
  // nonsense edges that the node-authoring `requires_edge` rules would catch
  // but the edge endpoint otherwise bypasses. Edge types absent from the map
  // accept any endpoints.
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

  try {
    const edge = await withTransaction(async (c) => {
      const txId = await createChangeset(c, {
        docoId: input.docoId,
        actor: input.actorId,
        source: "api",
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
        lifecycle: input.lifecycle ?? "asserted",
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

export type EdgeRetireResult =
  | { ok: true; id: string; edge: EdgeRow; footer_lines: string[] }
  | { error: string; status: number };

/** Retire an edge (the only "delete") through the commit() boundary. */
export async function retireEdgeRequest(input: {
  docoId: string;
  actorId: string | null;
  id: string;
  reason?: string | null;
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
      source: "api",
      reason: input.reason ?? "retire edge",
    });
    return retireEdge(c, txId, { id: input.id, actor: input.actorId });
  });
  return { ok: true, id: edge.id, edge, footer_lines: [`edge ${edge.id} retired`] };
}
