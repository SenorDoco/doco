import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { updateDecision, type DecisionPatch } from "~/lib/capture.server";

/**
 * PATCH /<owner>/<doco>/api/decisions/<id>.json — update an existing
 * Decision in place. Same admin gate + auth surface as the capture
 * endpoint. Setting `is_adr: false` demotes (clears scope_adr + number);
 * `is_adr: true` promotes (adds scope_adr + assigns next number).
 *
 * Resource route — no default export.
 */
export async function loader({
  params,
}: {
  params: { ownerSlug: string; docoSlug: string; id: string };
}) {
  return Response.json(
    {
      error:
        "Use PATCH (or POST) to update a decision. See /<owner>/<doco>/api/decisions.txt for the patch field list.",
      decision_id: params.id,
    },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string; id: string };
}) {
  const { ownerSlug, docoSlug, id } = params;
  const { me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: `Doco "${ownerSlug}/${docoSlug}" not found.` }, { status: 404 });
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
