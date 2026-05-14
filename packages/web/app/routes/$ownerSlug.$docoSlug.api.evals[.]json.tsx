// POST /<owner>/<doco>/api/evals.json — single-call Eval capture.
// Per the `eval-node-type-replaces-evo-and-evaluation` ADR.
//
// Resource route (no default export). Same auth/privacy model as the
// decisions/intents endpoints: cookie session OR `Authorization: Bearer
// <DOCO_TOKEN>`. Private Docos return 404 to non-members.
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead } from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { captureEval, type EvalDraft } from "~/lib/capture.server";

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
        "Use POST to capture an Eval. Required fields: name, scope_names, criterion={kind, spec?}. Optional: description, input, expected, target_ref, body_md, intent_ids, authored_by_username, lifecycle.",
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

  return withIdempotency(request, "POST /api/evals", me?.id ?? null, bodyText, async () => {
    let draft: EvalDraft;
    try {
      draft = JSON.parse(bodyText) as EvalDraft;
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    // Default the principal field to the authenticated user (see the matching
    // comment in api.decisions.json for why this guards the orphan-file bug).
    if (me && !draft.authored_by_username) draft.authored_by_username = me.username;
    const docoHost = new URL(request.url).origin;
    const result = await captureEval(dir, meta.docoId, ownerSlug, docoSlug, draft, docoHost);
    if ("error" in result) {
      return Response.json(result, { status: 400 });
    }
    return Response.json(result, { status: 201 });
  });
}
