import { getDocoByHandle } from "@doco/db";
import { validateRequestedDocoHandle } from "@doco/shared";
import { loadDocoRouteForAdmin, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { reindex, renameDocoHandle, updateDocoMeta } from "~/lib/redeem.server";

interface SettingsPatch {
  handle?: string;
  visibility?: "private" | "public";
  goal?: string;
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
    visibility: meta.visibility,
    goal: meta.goal,
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle, meta } = await loadDocoRouteForAdmin(request, params);

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
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  await reindex(meta.docoId);

  const row = await getDocoByHandle(finalHandle);
  return Response.json(
    {
      ok: true,
      doco_id: row?.id ?? meta.docoId,
      doco_handle: finalHandle,
      visibility: row?.visibility ?? "private",
      goal: row?.goal ?? "",
    },
    { status: 200 },
  );
}
