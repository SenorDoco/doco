import { getDocoByHandle } from "@doco/db";
import { validateRequestedDocoHandle } from "@doco/shared";
import { loadDocoRouteForAdmin, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { reindex, renameDocoHandle, updateDocoMeta } from "~/lib/redeem.server";

interface SettingsPatch {
  handle?: string;
  display_name?: string | null;
  visibility?: "private" | "public";
}

/**
 * /<doco-handle>/api/settings.json — single-call settings endpoint.
 *
 *  GET   returns the current settings (read-gated like the rest of the Doco).
 *  PATCH/POST updates fields (admin-gated). Handle rename updates the
 *  Postgres row and every URL that resolves through it.
 *
 * Same auth as decisions.json: cookie session OR Authorization: Bearer
 * <DOCO_ACCESS>. Private docos return 404 to non-members.
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
  const { meta } = await loadDocoRouteForRead(request, params);
  return Response.json({
    doco_id: meta.docoId,
    doco_handle: meta.handle,
    display_name: meta.displayName,
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
  const { dir: oldDir, handle, meta } = await loadDocoRouteForAdmin(request, params);

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

  let finalHandle = handle;
  if (patch.handle !== undefined && patch.handle !== handle) {
    const handleError = validateRequestedDocoHandle(patch.handle);
    if (handleError) return Response.json({ error: handleError }, { status: 400 });
    try {
      await renameDocoHandle({ oldHandle: handle, newHandle: patch.handle });
      finalHandle = patch.handle as typeof handle;
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  try {
    await updateDocoMeta({
      handle: finalHandle,
      ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  await reindex(oldDir, meta.docoId);

  const row = await getDocoByHandle(finalHandle);
  let display_name = row?.name ?? "";
  if (row && !display_name && typeof row.data.display_name === "string") {
    display_name = row.data.display_name;
  }
  return Response.json(
    {
      ok: true,
      doco_id: row?.id ?? meta.docoId,
      doco_handle: finalHandle,
      display_name,
      visibility: row?.visibility ?? "private",
    },
    { status: 200 },
  );
}
