import { docoPath } from "~/lib/db.server";
import { canAccessDoco, canAdminDoco } from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { getCurrentPrincipalAsync } from "~/lib/session";
import { captureDecision, type DecisionDraft } from "~/lib/capture.server";

/**
 * POST /<owner>/<doco>/api/decisions.json — single-call Decision capture.
 *
 * Resource route. Resolves scope_names / decided_by_username to ids
 * server-side, generates the ULID, writes the file, reindexes.
 * Replaces ~12 tool calls + 5 minutes with one POST + ~1 second.
 *
 * See /<owner>/<doco>/api/decisions.txt for the field spec.
 */
export async function loader({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return Response.json(
    {
      error: "Use POST to capture a decision. See /<owner>/<doco>/api/decisions.txt for the spec.",
      owner_slug: params.ownerSlug,
      doco_slug: params.docoSlug,
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
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = readDocoMetadata(dir);
  if (!meta) {
    return Response.json(
      { error: `Doco "${ownerSlug}/${docoSlug}" not found.` },
      { status: 404 },
    );
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!await canAccessDoco(meta, me?.id ?? null)) {
    // Don't leak existence of private Docos.
    return Response.json(
      { error: `Doco "${ownerSlug}/${docoSlug}" not found.` },
      { status: 404 },
    );
  }
  if (!await canAdminDoco(meta, me?.id ?? null)) {
    return Response.json(
      { error: "Forbidden: only the Doco's owner (or org admins) can capture decisions." },
      { status: 403 },
    );
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json(
      { error: "Content-Type must be application/json." },
      { status: 400 },
    );
  }
  const bodyText = await request.text();

  return withIdempotency(request, "POST /api/decisions", me?.id ?? null, bodyText, async () => {
    let draft: DecisionDraft;
    try {
      draft = JSON.parse(bodyText) as DecisionDraft;
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    // Default the principal fields to the authenticated user when the
    // client didn't specify. Lets agents POST without having to look
    // up usernames — and prevents the orphan-file bug where capture
    // used to write a YAML missing `decided_by` (NOT NULL in the index).
    if (me) {
      if (!draft.decided_by_username) draft.decided_by_username = me.username;
      if (!draft.created_by_id) draft.created_by_id = me.id;
    }
    const docoHost = new URL(request.url).origin;
    const result = await captureDecision(dir, meta.docoId, ownerSlug, docoSlug, draft, docoHost);
    if ("error" in result) {
      return Response.json(result, { status: 400 });
    }
    return Response.json(result, { status: 201 });
  });
}
