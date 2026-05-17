import { validateDocoSlug } from "@doco/shared";
import { rootDir } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { reindex, renameDocoSlug, updateDocoMeta } from "~/lib/redeem.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";

interface SettingsPatch {
  slug?: string;
  display_name?: string | null;
  description?: string | null;
  visibility?: "private" | "public";
}

/**
 * /<doco-handle>/api/settings.json — single-call settings endpoint.
 *
 *  GET   returns the current settings (read-gated like the rest of the Doco).
 *  PATCH/POST updates fields (admin-gated). Slug rename updates the
 *  Postgres row and every URL that resolves through it.
 *
 * Same auth as decisions.json: cookie session OR Authorization: Bearer
 * <DOCO_TOKEN>. Private docos return 404 to non-members.
 *
 * Resource route — no default export.
 */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { meta } = await loadDocoForRead(request, handle);
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
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { dir: oldDir } = await loadDocoForAdmin(request, handle);

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

  let finalSlug = docoSlug;
  let finalDir = oldDir;
  if (patch.slug !== undefined && patch.slug !== docoSlug) {
    const slugError = validateDocoSlug(patch.slug);
    if (slugError) return Response.json({ error: slugError }, { status: 400 });
    try {
      const { newDir } = await renameDocoSlug({
        root: rootDir(),
        ownerSlug,
        oldSlug: docoSlug,
        newSlug: patch.slug,
      });
      finalSlug = patch.slug;
      finalDir = newDir;
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  try {
    await updateDocoMeta({
      docoDir: finalDir,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  await reindex(finalDir);

  const updated = await readDocoMetadata(finalDir);
  return Response.json(
    {
      ok: true,
      owner_slug: ownerSlug,
      doco_slug: finalSlug,
      doco_id: updated?.docoId ?? null,
      display_name: updated?.displayName ?? "",
      description: updated?.description ?? "",
      visibility: updated?.visibility ?? "private",
    },
    { status: 200 },
  );
}
