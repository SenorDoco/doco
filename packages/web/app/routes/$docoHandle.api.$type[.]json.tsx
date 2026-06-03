// Per-entity capture endpoint — single dispatcher for all `simple capture`
// entity types. Adding a new entity type means adding a row to
// CAPTURE_REGISTRY below; no new route file required.
//
// Special-cased routes that need custom logic (e.g. /api/decisions/<id>
// with ADR promotion, /api/principals with role-principal seeding,
// /api/invites, /api/settings, /api/audit) keep their dedicated route
// files and win the match by being more specific in routes.ts.
//
// GET behaviour: returns a list of every node of the named type
// for this doco. Originally this loader returned a 405 telling the
// caller to POST, but the agent (and external scripts) want a real
// list endpoint per type. The list response shape is uniform across
// types so consumers can iterate without per-type branching:
//   { ok: true, type: "<plural>", doco_id, count, items: [...] }

import { listEntitiesByDoco } from "@doco/db";
import { type DocoRouteParams, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { CAPTURE_REGISTRY } from "~/lib/node-capture-registry.server";

function notFound(type: string | undefined): Response {
  if (type === "policies" || type === "policy") {
    return Response.json(
      {
        error: `${type} are policies, not nodes. Use /api/policies.json instead (GET to list, POST with "kind" to capture). See /api/policies.txt for the body shape.`,
      },
      { status: 404 },
    );
  }
  return Response.json({ error: `Unknown entity type "${type ?? ""}".` }, { status: 404 });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams & { type: string };
}) {
  const cfg = CAPTURE_REGISTRY[params.type];
  if (!cfg) return notFound(params.type);
  const { meta } = await loadDocoRouteForRead(request, params);
  const rows = await listEntitiesByDoco(cfg.entityType, meta.docoId);
  return Response.json({
    ok: true,
    type: params.type,
    doco_id: meta.docoId,
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      summary: r.summary ?? null,
      lifecycle: r.lifecycle ?? null,
      created_at: r.created_at ?? null,
      created_by: r.created_by ?? null,
      updated_at: r.updated_at ?? null,
      updated_by: r.updated_by ?? null,
      data: r.data,
      body_md: r.body_md ?? null,
    })),
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams & { type: string };
}) {
  const cfg = CAPTURE_REGISTRY[params.type];
  if (!cfg) return notFound(params.type);
  return cfg.build().action({ request, params });
}
