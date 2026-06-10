import { getEntity } from "@doco/db";
import { makeUpdateRoute } from "~/lib/api-capture-factory.server";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import { type DecisionPatch, updateDecision } from "~/lib/capture.server";
import { loadDocoRouteForRead, requireDocoTypeWriteForRequest } from "~/lib/doco-access.server";

/**
 * GET /<doco-handle>/api/decisions/<id>.json — read the Decision body.
 * Reachable from `/by-id/<doco_id>/decision_<ulid>.json` via the catchall
 * redirect. Shares the factory's generic entity-read loader.
 *
 * PATCH /<doco-handle>/api/decisions/<id>.json — update an existing
 * Decision in place. Custom action (not the factory's `updateEntity`)
 * because decisions carry rich structured fields and list patch helpers.
 *
 * Resource route — no default export.
 */
export const loader = makeUpdateRoute({
  type: "decisions",
  nodeType: "decision",
  pluralDir: "decisions",
}).loader;

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { id } = params;
  const { dir, docoSlug, me, meta, ownerSlug } = await loadDocoRouteForRead(
    request,
    params,
    "reader",
  );
  if (!me) {
    return Response.json({ error: "Authentication required to edit." }, { status: 401 });
  }
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Use PATCH or POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let patch: DecisionPatch;
  try {
    patch = (await request.json()) as DecisionPatch;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }
  const existing = await getEntity("decision", id);
  if (!existing || existing.doco_id !== meta.docoId) {
    return Response.json({ error: `decision not found: ${id}` }, { status: 404 });
  }
  const denied = await requireDocoTypeWriteForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
    "decision",
    "edit",
  );
  if (denied) return denied;
  const docoHost = new URL(request.url).origin;
  const result = await updateDecision(
    dir,
    meta.docoId,
    ownerSlug,
    docoSlug,
    id,
    patch,
    docoHost,
    me?.id ?? null,
    await authoringContextForRequest(request),
  );
  if ("error" in result) {
    return Response.json(result, { status: result.status ?? 400 });
  }
  return Response.json(result, { status: 200 });
}
