import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { updateEntity, type EntityPatch } from "~/lib/capture.server";

const ALLOWED = ["slug", "title", "wanted_by", "lifecycle", "summary", "body_md"];

export async function loader() {
  return Response.json({ error: "Use PATCH or POST with a JSON body." }, { status: 405 });
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
  const meta = readDocoMetadata(dir);
  if (!meta) return Response.json({ error: "Doco not found." }, { status: 404 });
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Use PATCH or POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let patch: EntityPatch;
  try {
    patch = (await request.json()) as EntityPatch;
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }
  const result = await updateEntity({
    docoDir: dir,
    docoId: meta.docoId,
    ownerSlug,
    docoSlug,
    nodeType: "intent",
    pluralDir: "intents",
    id,
    patch,
    allowedFields: ALLOWED,
    docoHost: new URL(request.url).origin,
    actorId: me?.id ?? null,
  });
  if ("error" in result) return Response.json(result, { status: result.status ?? 400 });
  return Response.json(result, { status: 200 });
}
