// POST /<doco>/api/edges.json  — create a first-class edge.
// GET  /<doco>/api/edges.json  — list live edges.
//
// Edge authoring (doco-vnext). Writes go through the append-only commit()
// boundary; per-edge-type write grants gate creation, exactly like nodes.

import { withClient } from "@doco/db";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import { canWriteDocoTypeForRequest, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { captureEdge } from "~/lib/edge-capture.server";

interface Params {
  docoHandle: string;
}

export async function loader({ request, params }: { request: Request; params: Params }) {
  const { meta } = await loadDocoRouteForRead(request, params);
  const rows = await withClient((c) =>
    c.query(
      `SELECT id, edge_type, from_id, from_node_type, to_id, to_node_type,
              props, lifecycle, created_at, created_by, updated_at, updated_by, retired_at
         FROM edges
        WHERE doco_id = $1 AND lifecycle <> 'retired'
        ORDER BY created_at DESC
        LIMIT 1000`,
      [meta.docoId],
    ),
  );
  return Response.json({ edges: rows.rows });
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
  const mayWrite = await canWriteDocoTypeForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
    edgeType,
  );
  if (!mayWrite) {
    return Response.json(
      { error: `Forbidden: write access on '${edgeType}' required to create this edge.` },
      { status: 403 },
    );
  }

  const result = await captureEdge({
    docoId: meta.docoId,
    actorId: me.id,
    edgeType,
    fromId,
    toId,
    props: (body.props as Record<string, unknown> | undefined) ?? null,
    lifecycle: body.lifecycle === "drafting" ? "drafting" : "asserted",
    reason: typeof body.reason === "string" ? body.reason : null,
    ...authoringContextForRequest(request),
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
