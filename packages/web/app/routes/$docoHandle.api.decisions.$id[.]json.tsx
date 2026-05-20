import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/doco-metadata.server";
import { updateDecision, type DecisionPatch } from "~/lib/capture.server";
import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

/**
 * GET /<doco-handle>/api/decisions/<id>.json — read the Decision body.
 * Reachable from `/by-id/<doco_id>/decision_<ulid>.json` via the catchall
 * redirect. Shares the factory's generic entity-read loader.
 *
 * PATCH /<doco-handle>/api/decisions/<id>.json — update an existing
 * Decision in place. Custom action (not the factory's `updateEntity`)
 * because decisions carry ADR-specific logic: setting `is_adr: false`
 * demotes (clears scope_adr + number); `is_adr: true` promotes (adds
 * scope_adr + assigns next number).
 *
 * Resource route — no default export.
 */
export const loader = makeUpdateRoute({
  type: "decisions",
  nodeType: "decision",
  pluralDir: "decisions",
  allowedFields: [],
}).loader;

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { id } = params;
  const { me } = await loadDocoForAdmin(request, handle);
  const dir = docoPath(handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: `Doco "${handle}" not found.` }, { status: 404 });
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
  const docoHost = new URL(request.url).origin;
  const result = await updateDecision(dir, meta.docoId, ownerSlug, docoSlug, id, patch, docoHost, me?.id ?? null);
  if ("error" in result) {
    return Response.json(result, { status: result.status ?? 400 });
  }
  return Response.json(result, { status: 200 });
}
