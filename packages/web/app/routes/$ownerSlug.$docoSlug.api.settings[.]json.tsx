import { loadDocoForAdmin, loadDocoForRead } from "~/lib/doco-access.server";
import { applyDocoSettings, type SettingsPatch } from "~/lib/doco-settings.server";

/**
 * /<owner>/<doco>/api/settings.json — single-call settings endpoint.
 *
 *  GET   returns the current settings (read-gated like the rest of the Doco).
 *  PATCH/POST updates fields (admin-gated). Slug rename moves the directory.
 *
 * Same auth as decisions.json: cookie session OR Authorization: Bearer
 * <DOCO_TOKEN>. Private Docos return 404 to non-members.
 *
 * Resource route — no default export.
 */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { meta } = await loadDocoForRead(request, ownerSlug, docoSlug);
  return Response.json({
    owner_slug: ownerSlug,
    doco_slug: docoSlug,
    doco_id: meta.docoId,
    display_name: meta.displayName,
    description: meta.description,
    visibility: meta.visibility,
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { dir: oldDir } = await loadDocoForAdmin(request, ownerSlug, docoSlug);

  if (request.method !== "POST" && request.method !== "PATCH") {
    return Response.json({ error: "Use POST or PATCH." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let patch: SettingsPatch;
  try {
    patch = (await request.json()) as SettingsPatch;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }

  const result = await applyDocoSettings({ ownerSlug, docoSlug, oldDir, patch });
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json(
    {
      ok: true,
      owner_slug: ownerSlug,
      doco_slug: result.finalSlug,
      doco_id: result.doco_id,
      display_name: result.display_name,
      description: result.description,
      visibility: result.visibility,
    },
    { status: 200 },
  );
}
