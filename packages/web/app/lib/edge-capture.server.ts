// Edge authoring. The web entry point for creating and
// retiring FIRST-CLASS edges. Every mutation goes through the append-only
// commit() boundary (changeset + immutable version snapshot), so edges get
// their own id, lifecycle, provenance, and history — peers of nodes.
//
// Package-only imports (no ~ alias) so this is unit-testable outside the
// react-router runtime (see scripts/edge-capture-test.ts).

import {
  type CommitSource,
  EDGE_ENDPOINTS_NOT_ACTIVE,
  type EdgeRow,
  type NodeRow,
  createChangeset,
  createEdge,
  getEntity,
  retireActiveEdgesForNode,
  retireEdge,
  updateEdge,
  withClient,
  withTransaction,
} from "@doco/db";
import {
  EDGE_ENDPOINT_TYPES,
  EDGE_TYPES,
  type Lifecycle,
  NODE_TYPES,
  isEntityId,
  parseEntityId,
} from "@doco/shared";
import { runEdgeAuthoringPolicies } from "./authoring-runner.server";
import { type EdgeFooterOp, renderEdgeOperationLine } from "./capture.server";
import { LIFECYCLE_ORDER } from "./node-colors";

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);
const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

/** A node's lifecycle is `active` (the column defaults to it, so treat a
 *  missing value as active). Drives the "active edge ⟹ active endpoints" rule. */
function isActiveLifecycle(lifecycle: string | null | undefined): boolean {
  return (lifecycle ?? "active") === "active";
}

export interface CaptureEdgeInput {
  docoId: string;
  actorId: string | null;
  edgeType: string;
  fromId: string;
  toId: string;
  /** flows_to BPMN metadata (typed edge columns). */
  label?: string | null;
  condition?: string | null;
  kind?: string | null;
  /** Stage a new edge starts in. `retired` is reached via retireEdgeRequest. */
  lifecycle?: Exclude<Lifecycle, "retired">;
  reason?: string | null;
  source?: CommitSource;
  metadata?: Record<string, unknown> | null;
  /** Absolute base URL for footer entity links (e.g. the request origin). */
  docoHost?: string;
  /** Canonical handle for footer link URLs (falls back to a `docoId` lookup). */
  handle?: string;
}

export type EdgeCaptureResult =
  | { ok: true; id: string; path: string; edge: EdgeRow; footer_lines: string[] }
  | { error: string; status: number };

async function resolveEndpoint(
  docoId: string,
  id: string,
): Promise<{ ok: true; type: string; rec: NodeRow } | { error: string }> {
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
function endpointPayload(rec: NodeRow): Record<string, unknown> {
  const prose = rec.prose || null;
  return {
    name: prose,
    text: prose,
    ...rec.extra,
    ...(rec.kind != null ? { kind: rec.kind } : {}),
    ...(rec.locator != null ? { locator: rec.locator } : {}),
  };
}

/** Human-readable label for an edge endpoint: its prose, else its id. */
function endpointLabel(rec: NodeRow | null, fallbackId: string): string {
  return rec ? rec.prose || fallbackId : fallbackId;
}

/**
 * Build the friendly footer line(s) for an edge mutation: the same emoji +
 * named-and-linked endpoints + authoring/timing shape a node mutation emits.
 * Endpoint records are resolved from the DB unless the caller already holds
 * them (creation does, via `resolveEndpoint`), sparing two reads.
 */
async function edgeFooterLines(
  edge: EdgeRow,
  op: EdgeFooterOp,
  opts: {
    docoHost?: string | undefined;
    handle?: string | undefined;
    duration_ms?: number | undefined;
    authoringPoliciesPassed?: number | undefined;
    fromRec?: NodeRow | null;
    toRec?: NodeRow | null;
  },
): Promise<string[]> {
  const fromRec = opts.fromRec ?? (await getEntity(edge.from_node_type, edge.from_id));
  const toRec = opts.toRec ?? (await getEntity(edge.to_node_type, edge.to_id));
  const line = await renderEdgeOperationLine({
    handle: opts.handle,
    docoId: edge.doco_id,
    docoHost: opts.docoHost,
    edgeId: edge.id,
    edgeType: edge.edge_type,
    op,
    from: {
      id: edge.from_id,
      type: edge.from_node_type,
      label: endpointLabel(fromRec, edge.from_id),
    },
    to: { id: edge.to_id, type: edge.to_node_type, label: endpointLabel(toRec, edge.to_id) },
    duration_ms: opts.duration_ms,
    authoringPoliciesPassed: opts.authoringPoliciesPassed,
  });
  return [line];
}

/** Create a first-class edge through the commit() boundary. */
export async function captureEdge(input: CaptureEdgeInput): Promise<EdgeCaptureResult> {
  const started = performance.now();
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

  // Global lifecycle invariant (active edge ⟹ active endpoints). An EXPLICIT
  // `active` against a non-active endpoint is rejected (the createEdge boundary
  // throws the sentinel, mapped to a 422 below). An UNSPECIFIED lifecycle
  // defaults to `active` only when both endpoints are active, else to
  // `drafting` — so relate/import "just works" without ever minting an invalid
  // active edge (and a `supersede`'s replaces-edge to the just-retired node
  // lands as `drafting`).
  const endpointsActive =
    isActiveLifecycle(from.rec.lifecycle) && isActiveLifecycle(to.rec.lifecycle);
  const lifecycle: Exclude<Lifecycle, "retired"> =
    input.lifecycle ?? (endpointsActive ? "active" : "drafting");

  // Edge-scoped authoring policies. The deterministic `requires_edge_type`
  // allowlist is a structural membership gate, so it fires on EVERY edge —
  // including a `drafting` sketch (a disallowed edge type is never created). The
  // LLM-judged quality checks (e.g. a sub-process child Intent's name must be
  // the base form of the calling Action that `supports` it) are exempt while
  // `drafting`, mirroring the node lifecycle exemption.
  const includeProbabilistic = lifecycle !== "drafting";
  const pred = await runEdgeAuthoringPolicies({
    docoId: input.docoId,
    edge: {
      edge_type: input.edgeType,
      from_node_type: from.type,
      to_node_type: to.type,
    },
    judgeCandidate: {
      id: `${input.fromId}->${input.toId}`,
      edge_type: input.edgeType,
      [from.type]: endpointPayload(from.rec),
      [to.type]: endpointPayload(to.rec),
    },
    includeProbabilistic,
  });
  if (pred.blocking) {
    return { error: pred.blocking.reason, status: 422 };
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
        label: input.label ?? null,
        condition: input.condition ?? null,
        kind: input.kind ?? null,
        lifecycle,
        actor: input.actorId,
      });
    });
    return {
      ok: true,
      id: edge.id,
      path: `/api/edges/${edge.id}.json`,
      edge,
      footer_lines: await edgeFooterLines(
        edge,
        { kind: "added" },
        {
          docoHost: input.docoHost,
          handle: input.handle,
          duration_ms: performance.now() - started,
          authoringPoliciesPassed: pred.passed,
          fromRec: from.rec,
          toRec: to.rec,
        },
      ),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(EDGE_ENDPOINTS_NOT_ACTIVE)) {
      return { error: activeEndpointError(msg), status: 422 };
    }
    if (/edges_live_uniq|duplicate key/.test(msg)) {
      return {
        error: `A live '${input.edgeType}' edge already exists between these nodes.`,
        status: 409,
      };
    }
    return { error: msg, status: 500 };
  }
}

/** Friendly rendering of the endpoint-invariant violation thrown at the
 *  edge-write boundary (strips the internal sentinel prefix). */
function activeEndpointError(msg: string): string {
  const detail = msg.split(`${EDGE_ENDPOINTS_NOT_ACTIVE}: `)[1] ?? msg;
  return `Cannot make this edge active: ${detail}.`;
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
 * the Doco. The live-unique index (doco, from, to, edge_type) is the edge's
 * identity — two nodes are connected by at most one live edge of each type.
 */
export async function edgeExists(
  docoId: string,
  edgeType: string,
  fromId: string,
  toId: string,
): Promise<boolean> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ x: number }>(
      `SELECT 1 AS x FROM edges
        WHERE doco_id = $1 AND edge_type = $2 AND from_id = $3 AND to_id = $4
          AND lifecycle <> 'retired'
        LIMIT 1`,
      [docoId, edgeType, fromId, toId],
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
  docoHost?: string;
  handle?: string;
}): Promise<EdgeRetireResult> {
  const started = performance.now();
  const existing = await getEdgeById(input.docoId, input.id);
  if (!existing) return { error: `edge not found: ${input.id}`, status: 404 };
  const footerOpts = { docoHost: input.docoHost, handle: input.handle };
  if (existing.lifecycle === "retired") {
    return {
      ok: true,
      id: existing.id,
      edge: existing,
      footer_lines: await edgeFooterLines(existing, { kind: "retired" }, footerOpts),
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
  return {
    ok: true,
    id: edge.id,
    edge,
    footer_lines: await edgeFooterLines(
      edge,
      { kind: "retired" },
      { ...footerOpts, duration_ms: performance.now() - started },
    ),
  };
}

/**
 * Retire every active edge touching a node, through the commit() boundary —
 * the opt-in `retire_active_edges` cascade behind a node demotion, restoring
 * the "active edge ⟹ active endpoints" invariant. A no-op (retired: 0) when the
 * node has no active edges.
 */
export async function retireActiveEdgesRequest(input: {
  docoId: string;
  actorId: string | null;
  nodeId: string;
  reason?: string | null;
  source?: CommitSource;
  metadata?: Record<string, unknown> | null;
  docoHost?: string;
  handle?: string;
}): Promise<{ retired: number; footer_lines: string[] }> {
  const retired = await withTransaction(async (c) => {
    const txId = await createChangeset(c, {
      docoId: input.docoId,
      actor: input.actorId,
      source: input.source ?? "api",
      metadata: input.metadata ?? null,
      reason: input.reason ?? "retire active edges of demoted node",
    });
    return retireActiveEdgesForNode(c, txId, {
      docoId: input.docoId,
      nodeId: input.nodeId,
      actor: input.actorId,
    });
  });
  const footerOpts = { docoHost: input.docoHost, handle: input.handle };
  const footer_lines: string[] = [];
  for (const edge of retired) {
    footer_lines.push(...(await edgeFooterLines(edge, { kind: "retired" }, footerOpts)));
  }
  return { retired: retired.length, footer_lines };
}

// Edges move through the same canonical lifecycle as nodes:
// drafting → queued → active → retired.
export const EDGE_LIFECYCLES = LIFECYCLE_ORDER;
export type EdgeLifecycle = Lifecycle;

export type EdgeLifecycleResult =
  | { ok: true; id: string; edge: EdgeRow; footer_lines: string[] }
  | { error: string; status: number };

/**
 * Move an edge through its lifecycle (drafting / queued / active / retired) via
 * the commit() boundary. Retiring routes through `retireEdgeRequest`; reviving a
 * retired edge clears its retirement stamp (see `updateEdge`) and can collide
 * with the live-unique slot, which we surface as a 409.
 */
export async function setEdgeLifecycleRequest(input: {
  docoId: string;
  actorId: string | null;
  id: string;
  lifecycle: EdgeLifecycle;
  reason?: string | null;
  source?: CommitSource;
  metadata?: Record<string, unknown> | null;
  docoHost?: string;
  handle?: string;
}): Promise<EdgeLifecycleResult> {
  const started = performance.now();
  if (!EDGE_LIFECYCLES.includes(input.lifecycle)) {
    return {
      error: `Unknown edge lifecycle '${input.lifecycle}'. Valid: ${EDGE_LIFECYCLES.join(", ")}.`,
      status: 400,
    };
  }
  if (input.lifecycle === "retired") {
    const { lifecycle: _lifecycle, ...retireInput } = input;
    return retireEdgeRequest(retireInput);
  }
  // Narrowed past the `retired` early return; pin it in a local so the
  // transaction closure below keeps the non-retired type.
  const lifecycle: Exclude<Lifecycle, "retired"> = input.lifecycle;
  const footerOpts = { docoHost: input.docoHost, handle: input.handle };

  const existing = await getEdgeById(input.docoId, input.id);
  if (!existing) return { error: `edge not found: ${input.id}`, status: 404 };
  if (existing.lifecycle === lifecycle) {
    return {
      ok: true,
      id: existing.id,
      edge: existing,
      footer_lines: await edgeFooterLines(
        existing,
        { kind: "lifecycle", to: lifecycle },
        footerOpts,
      ),
    };
  }

  try {
    const edge = await withTransaction(async (c) => {
      const txId = await createChangeset(c, {
        docoId: input.docoId,
        actor: input.actorId,
        source: input.source ?? "api",
        metadata: input.metadata ?? null,
        reason: input.reason ?? `set edge lifecycle to ${lifecycle}`,
      });
      return updateEdge(c, txId, {
        id: input.id,
        lifecycle,
        actor: input.actorId,
      });
    });
    return {
      ok: true,
      id: edge.id,
      edge,
      footer_lines: await edgeFooterLines(
        edge,
        { kind: "lifecycle", to: lifecycle },
        { ...footerOpts, duration_ms: performance.now() - started },
      ),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(EDGE_ENDPOINTS_NOT_ACTIVE)) {
      return { error: activeEndpointError(msg), status: 422 };
    }
    if (/edges_live_uniq|duplicate key/.test(msg)) {
      return {
        error: `A live '${existing.edge_type}' edge already exists between these nodes.`,
        status: 409,
      };
    }
    return { error: msg, status: 500 };
  }
}
