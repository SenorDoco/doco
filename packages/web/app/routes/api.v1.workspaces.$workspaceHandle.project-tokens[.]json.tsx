// GET/POST/DELETE /api/v1/workspaces/<workspace-handle>/project-tokens.json:
// owner-only management of the workspace's committable read-only project
// tokens (lib/project-tokens.server).
//
// GET    → list (revoked + active), summaries only (no token bodies).
// POST   → mint a token. Requires `confirm_repo_readable: true` in the JSON
//          body: the owner acknowledges that anyone with read access to the
//          repository the token is committed to will read every Doco of the
//          workspace. `install_hint` is the message for the agent: where to
//          save the token and how to turn on the Doco hook.
// DELETE → revoke a token by its 8-character id (?id=…). Idempotent.
//
// Errors: 401 anonymous, 403 not an owner, 404 no such workspace, 400 POST
// without the confirmation or DELETE without ?id=.

import { getPublicBaseUrl } from "@doco/shared";
import {
  listProjectTokens,
  mintProjectToken,
  projectTokenInstallHint,
  revokeProjectTokenById,
} from "~/lib/project-tokens.server";
import { loadWorkspaceForOwner } from "~/lib/workspace-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const owner = await loadWorkspaceForOwner(request, params.workspaceHandle);
  if (!owner.ok) return Response.json({ error: owner.error }, { status: owner.status });
  return Response.json({ tokens: await listProjectTokens(owner.workspace.id) });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const owner = await loadWorkspaceForOwner(request, params.workspaceHandle);
  if (!owner.ok) return Response.json({ error: owner.error }, { status: owner.status });
  const { workspace, me } = owner;

  if (request.method === "POST") {
    let body: { confirm_repo_readable?: boolean; label?: string } = {};
    try {
      body = (await request.json()) as { confirm_repo_readable?: boolean; label?: string };
    } catch {
      // An empty body falls through to the confirmation check.
    }
    if (body.confirm_repo_readable !== true) {
      return Response.json(
        {
          error: "confirmation_required",
          hint: "Pass { confirm_repo_readable: true } in the request body: the owner acknowledges that anyone with read access to the repository this token is committed to will read every doco in the workspace.",
        },
        { status: 400 },
      );
    }
    const result = await mintProjectToken({
      workspace_id: workspace.id,
      created_by_user_id: me.id,
      label: body.label ?? null,
    });
    // The full token is returned once, on mint; later GETs return summaries.
    return Response.json({
      token: result.full_token,
      summary: result.summary,
      install_hint: projectTokenInstallHint(
        getPublicBaseUrl(request),
        workspace.handle,
        result.full_token,
      ),
    });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id || id.length < 4) {
    return Response.json(
      { error: "missing_id", hint: "Pass ?id=<8-character id> in the query string." },
      { status: 400 },
    );
  }
  const revoked = await revokeProjectTokenById({ workspace_id: workspace.id, token_suffix_id: id });
  return Response.json({ revoked });
}
