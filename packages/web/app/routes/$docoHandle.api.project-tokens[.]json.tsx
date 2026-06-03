// POST/GET/DELETE /<doco-handle>/api/project-tokens.json — owner-only
// management of committable read-only project tokens.
//
// GET    → list (revoked + active), summary only (no token bodies).
// POST   → mint a new token. Requires `confirm_repo_readable: true`
//          in the JSON body so the owner explicitly acknowledges
//          that anyone with read access to the repository where this
//          token is committed will be able to read the Doco.
// DELETE → revoke a token by its 8-char suffix id (passed in the
//          ?id=... query string). Idempotent: a no-op on tokens
//          that don't exist or are already revoked.
//
// Errors:
//   401 — anonymous caller
//   403 — caller is not the Doco's owner
//   400 — POST without the confirmation flag, or DELETE without ?id=

import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { canAdminDocoForRequest } from "~/lib/doco-access.server";
import {
  listProjectTokens,
  mintProjectToken,
  revokeProjectTokenById,
} from "~/lib/project-tokens.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { meta, me } = await loadDocoRouteForRead(request, params);
  const ok = await canAdminDocoForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me?.id ?? null,
  );
  if (!ok) {
    return Response.json(
      { error: "Only the Doco's owner can list project tokens." },
      { status: 403 },
    );
  }
  const tokens = await listProjectTokens(meta.docoId);
  return Response.json({ tokens });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const { meta, me } = await loadDocoRouteForRead(request, params);
  if (!me) {
    return Response.json(
      { error: "anonymous_callers_cannot_manage_project_tokens" },
      { status: 401 },
    );
  }
  const ok = await canAdminDocoForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
  );
  if (!ok) {
    return Response.json(
      { error: "Only the Doco's owner can manage project tokens." },
      { status: 403 },
    );
  }

  if (request.method === "POST") {
    let body: { confirm_repo_readable?: boolean; label?: string } = {};
    try {
      body = (await request.json()) as { confirm_repo_readable?: boolean; label?: string };
    } catch {
      // Empty body — fall through to the confirm check.
    }
    if (body.confirm_repo_readable !== true) {
      return Response.json(
        {
          error: "confirmation_required",
          hint: "Pass { confirm_repo_readable: true } in the request body. The owner must acknowledge that anyone with read access to the repository this token is committed to will be able to read the Doco.",
        },
        { status: 400 },
      );
    }
    const result = await mintProjectToken({
      doco_id: meta.docoId,
      created_by_user_id: me.id,
      label: body.label ?? null,
    });
    // The full token is returned ONCE on mint and never again — the
    // owner copies it into .doco/project-tokens.json now. Subsequent
    // GETs return summaries only.
    return Response.json({
      token: result.full_token,
      summary: result.summary,
      install_hint: buildInstallHint(meta.handle, result.full_token),
    });
  }

  // DELETE
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || id.length < 4) {
    return Response.json(
      { error: "missing_id", hint: "Pass ?id=<8-char-suffix> in the query string." },
      { status: 400 },
    );
  }
  const revoked = await revokeProjectTokenById({
    doco_id: meta.docoId,
    token_suffix_id: id,
  });
  return Response.json({ revoked });
}

function buildInstallHint(handle: string, fullToken: string): string {
  return [
    "Save this token now — it is shown once and cannot be recovered.",
    "",
    "Commit it to the repository at `.doco/project-tokens.json`:",
    "",
    "```json",
    "{",
    `  "${handle}": "${fullToken}"`,
    "}",
    "```",
    "",
    "Then commit and push the file. Any agent that clones the repo and uses the bundled MCP server will read this token automatically — no OAuth needed.",
    "",
    "Revoke from this page if the repo's read access changes.",
  ].join("\n");
}
