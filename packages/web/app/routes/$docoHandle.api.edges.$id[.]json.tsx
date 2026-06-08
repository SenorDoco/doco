// GET    /<doco>/api/edges/<id>.json            — read an edge (+ ?as_of=<tx>).
// GET    /<doco>/api/edges/<id>.json?history=1  — full version history.
// DELETE /<doco>/api/edges/<id>.json            — retire the edge.
// POST   /<doco>/api/edges/<id>.json {op:"retire"} — retire (DELETE-less clients).
// PATCH  /<doco>/api/edges/<id>.json {lifecycle} — move the edge's lifecycle
//        (drafting / queued / active / retired). Drives the edge dialog's buttons.
//
// Time-travel reads are O(1) snapshot lookups: "how it was"
// never replays a log.

import { entityAsOf, getVersions, verifyHistory, withClient } from "@doco/db";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import { loadDocoRouteForRead, requireDocoTypeWriteForRequest } from "~/lib/doco-access.server";
import {
  EDGE_LIFECYCLES,
  type EdgeLifecycle,
  getEdgeById,
  retireEdgeRequest,
  setEdgeLifecycleRequest,
} from "~/lib/edge-capture.server";

interface Params {
  docoHandle: string;
  id: string;
}

export async function loader({ request, params }: { request: Request; params: Params }) {
  const { meta } = await loadDocoRouteForRead(request, params);
  const { id } = params;
  const edge = await getEdgeById(meta.docoId, id);
  if (!edge) {
    return Response.json({ error: `edge not found: ${id}` }, { status: 404 });
  }
  const url = new URL(request.url);

  // ?as_of=<tx_id> — reconstruct the edge as it stood at that commit.
  const asOf = url.searchParams.get("as_of");
  if (asOf) {
    const txId = Number(asOf);
    if (!Number.isFinite(txId)) {
      return Response.json({ error: "as_of must be a numeric tx_id." }, { status: 400 });
    }
    const snapshot = await withClient((c) => entityAsOf(c, "edge", id, txId));
    return Response.json({ id, as_of: txId, snapshot });
  }

  // ?history=1 — the full append-only version timeline.
  if (url.searchParams.get("history")) {
    const versions = await withClient((c) => getVersions(c, "edge", id));
    return Response.json({ id, edge, versions });
  }

  // ?verify=1 — verify the Merkle hash chain (tamper-evidence).
  if (url.searchParams.get("verify")) {
    const result = await withClient((c) => verifyHistory(c, "edge", id));
    return Response.json({ id, ...result });
  }

  return Response.json({ edge });
}

export async function action({ request, params }: { request: Request; params: Params }) {
  const { me, meta } = await loadDocoRouteForRead(request, params, "reader");
  const { id } = params;
  if (!me) {
    return Response.json({ error: "Authentication required to edit." }, { status: 401 });
  }
  if (request.method !== "DELETE" && request.method !== "POST" && request.method !== "PATCH") {
    return Response.json(
      { error: "Use PATCH {lifecycle}, DELETE, or POST {op:'retire'}." },
      { status: 405 },
    );
  }

  const edge = await getEdgeById(meta.docoId, id);
  if (!edge) {
    return Response.json({ error: `edge not found: ${id}` }, { status: 404 });
  }

  // Permission keys off the edge's own type — same per-type engine as nodes.
  const denied = await requireDocoTypeWriteForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
    edge.edge_type,
    "change this edge",
  );
  if (denied) return denied;

  const authoring = await authoringContextForRequest(request);

  // PATCH moves the edge along its lifecycle (drafting / queued / active / retired).
  if (request.method === "PATCH") {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    const lifecycle = body.lifecycle;
    if (typeof lifecycle !== "string" || !EDGE_LIFECYCLES.includes(lifecycle as EdgeLifecycle)) {
      return Response.json(
        { error: `lifecycle must be one of: ${EDGE_LIFECYCLES.join(", ")}.` },
        { status: 400 },
      );
    }
    const result = await setEdgeLifecycleRequest({
      docoId: meta.docoId,
      actorId: me.id,
      id,
      lifecycle: lifecycle as EdgeLifecycle,
      reason: typeof body.reason === "string" ? body.reason : null,
      docoHost: new URL(request.url).origin,
      handle: params.docoHandle,
      ...authoring,
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    return Response.json({
      ok: true,
      id: result.id,
      edge: result.edge,
      footer_lines: result.footer_lines,
    });
  }

  let reason: string | null = null;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (typeof body.reason === "string") reason = body.reason;
    } catch {
      // tolerate empty/non-JSON bodies for POST-retire
    }
  }

  const result = await retireEdgeRequest({
    docoId: meta.docoId,
    actorId: me.id,
    id,
    reason,
    docoHost: new URL(request.url).origin,
    handle: params.docoHandle,
    ...authoring,
  });
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({
    ok: true,
    id: result.id,
    edge: result.edge,
    footer_lines: result.footer_lines,
  });
}
