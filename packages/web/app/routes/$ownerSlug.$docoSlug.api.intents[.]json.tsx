import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead } from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { captureIntent, type IntentDraft } from "~/lib/capture.server";

/**
 * POST /<owner>/<doco>/api/intents.json — single-call Intent capture.
 *
 * Same auth + privacy model as decisions.json. Resolves scope names and
 * principal username server-side. Returns `footer_lines` ready to paste.
 *
 * See /<owner>/<doco>/api/intents.txt for the field spec.
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
        "Use POST to capture an intent. See /<owner>/<doco>/api/intents.txt for the spec.",
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

  return withIdempotency(request, "POST /api/intents", me?.id ?? null, bodyText, async () => {
    let draft: IntentDraft;
    try {
      draft = JSON.parse(bodyText) as IntentDraft;
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    // Default the principal field to the authenticated user (see the matching
    // comment in api.decisions.json for why this guards the orphan-file bug).
    if (me && !draft.wanted_by_username) draft.wanted_by_username = me.username;
    const docoHost = new URL(request.url).origin;
    const result = await captureIntent(dir, meta.docoId, ownerSlug, docoSlug, draft, docoHost);
    if ("error" in result) {
      return Response.json(result, { status: 400 });
    }
    return Response.json(result, { status: 201 });
  });
}
