// POST /<doco>/api/edges.json  — create a first-class edge.
// GET  /<doco>/api/edges.json  — list live edges.
//   ?from_id=<node_id>        scope to edges originating at one node
//   ?to_id=<node_id>          scope to edges targeting one node
//   ?include_retired=true     include retired edges (default: live only)
// from_id and to_id are independent filters; supplying both narrows to the
// edges between those two nodes — the way to pin one edge's id by its
// endpoints (e.g. before retiring it).
//
// The list response uses the same envelope as every other list endpoint
// (`GET /api/<type>.json`): { ok, type, doco_id, count, items }. One shape
// lets agents iterate without per-endpoint branching, and lets the doco_api
// result truncator trim `items` gracefully instead of slicing a bespoke
// array into invalid JSON.
//
// Edge authoring. Writes go through the append-only commit()
// boundary; per-edge-type write grants gate creation, exactly like nodes.

import { withClient } from "@doco/db";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import { loadDocoRouteForRead, requireDocoTypeWriteForRequest } from "~/lib/doco-access.server";
import { captureEdge } from "~/lib/edge-capture.server";

interface Params {
  docoHandle: string;
}

export async function loader({ request, params }: { request: Request; params: Params }) {
  const { meta } = await loadDocoRouteForRead(request, params);

  // Honor the documented query params so the JSON API agrees with the node
  // panel, which scopes a node's edges by both endpoints: `from_id` keeps the
  // edges leaving a node, `to_id` the edges entering it, and supplying both
  // narrows to the edges between the two. `include_retired=true` widens the
  // default live-only view to include retired edges.
  const url = new URL(request.url);
  const fromId = url.searchParams.get("from_id");
  const toId = url.searchParams.get("to_id");
  const includeRetired = url.searchParams.get("include_retired") === "true";

  const conditions = ["doco_id = $1"];
  const args: unknown[] = [meta.docoId];
  if (!includeRetired) {
    conditions.push("lifecycle <> 'retired'");
  }
  if (fromId) {
    args.push(fromId);
    conditions.push(`from_id = $${args.length}`);
  }
  if (toId) {
    args.push(toId);
    conditions.push(`to_id = $${args.length}`);
  }

  const rows = await withClient((c) =>
    c.query(
      `SELECT id, edge_type, from_id, from_node_type, to_id, to_node_type,
              label, condition, kind, lifecycle, created_at, created_by, updated_at, updated_by, retired_at
         FROM edges
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT 1000`,
      args,
    ),
  );
  return Response.json({
    ok: true,
    type: "edges",
    doco_id: meta.docoId,
    count: rows.rows.length,
    items: rows.rows,
  });
}

export async function action({ request, params }: { request: Request; params: Params }) {
  const { me, meta } = await loadDocoRouteForRead(request, params, "reader");
  if (!me) {
    return Response.json({ error: "Authentication required to write." }, { status: 401 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }

  const edgeType = body.edge_type;
  const fromId = body.from_id;
  const toId = body.to_id;
  if (typeof edgeType !== "string" || typeof fromId !== "string" || typeof toId !== "string") {
    return Response.json(
      { error: "edge_type, from_id, and to_id (strings) are required." },
      { status: 400 },
    );
  }

  // Per-type write enforcement — same engine as nodes; edge types are part
  // of the grantable universe (WRITABLE_TYPES).
  const denied = await requireDocoTypeWriteForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
    edgeType,
    "create this edge",
  );
  if (denied) return denied;

  const result = await captureEdge({
    docoId: meta.docoId,
    actorId: me.id,
    edgeType,
    fromId,
    toId,
    label: typeof body.label === "string" ? body.label : null,
    condition: typeof body.condition === "string" ? body.condition : null,
    kind: typeof body.kind === "string" ? body.kind : null,
    // Pass an explicit stage straight through; omit otherwise so captureEdge
    // applies the default (active iff both endpoints are active, else drafting).
    ...(body.lifecycle === "drafting" || body.lifecycle === "queued" || body.lifecycle === "active"
      ? { lifecycle: body.lifecycle }
      : {}),
    reason: typeof body.reason === "string" ? body.reason : null,
    docoHost: new URL(request.url).origin,
    handle: params.docoHandle,
    ...(await authoringContextForRequest(request)),
  });
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json(
    {
      ok: true,
      id: result.id,
      path: result.path,
      edge: result.edge,
      footer_lines: result.footer_lines,
    },
    { status: 201 },
  );
}
