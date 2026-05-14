import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead } from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { captureAction, type ActionDraft } from "~/lib/capture.server";

/**
 * POST /<owner>/<doco>/api/actions.json — single-call Action capture.
 *
 * Same auth + privacy model as decisions.json / intents.json. Resolves
 * scope names and principal username server-side. Returns `footer_lines`
 * ready to paste.
 */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  await loadDocoForRead(request, params.ownerSlug, params.docoSlug);
  return Response.json(
    {
      error:
        "Use POST to capture an action. See /<owner>/<doco>/api/actions.txt for the spec.",
    },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: `Doco "${ownerSlug}/${docoSlug}" not found.` }, { status: 404 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  const bodyText = await request.text();

  return withIdempotency(request, "POST /api/actions", me?.id ?? null, bodyText, async () => {
    let draft: ActionDraft;
    try {
      draft = JSON.parse(bodyText) as ActionDraft;
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    if (me) {
      if (!draft.performed_by_username) draft.performed_by_username = me.username;
      if (!draft.created_by_id) draft.created_by_id = me.id;
    }
    const docoHost = new URL(request.url).origin;
    const result = await captureAction(dir, meta.docoId, ownerSlug, docoSlug, draft, docoHost);
    if ("error" in result) {
      return Response.json(result, { status: 400 });
    }
    return Response.json(result, { status: 201 });
  });
}
