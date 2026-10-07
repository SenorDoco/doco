// GET/POST/DELETE /api/v1/workspaces/<workspace-handle>/project-tokens.json:
// a member's read-only project tokens for the workspace, each reading it as
// them (lib/project-tokens.server). An owner sees and revokes everyone's.
//
// GET    → list (revoked + active), summaries only (no token bodies).
// POST   → mint a token (optional `label` in the JSON body). `install_hint`
//          is the message for the agent: where to save the token, kept out
//          of git, and how to turn on the Doco hook.
// DELETE → revoke a token by its 8-character id (?id=…). Idempotent.
//
// Errors: 401 anonymous, 403 not a member, 404 no such workspace, 400 DELETE
// without ?id=.

import { getPublicBaseUrl } from "@doco/shared";
import {
  listProjectTokens,
  mintProjectToken,
  projectTokenInstallHint,
  revokeProjectTokenById,
} from "~/lib/project-tokens.server";
import { loadWorkspaceForProjectTokens } from "~/lib/workspace-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const member = await loadWorkspaceForProjectTokens(request, params.workspaceHandle);
  if (!member.ok) return Response.json({ error: member.error }, { status: member.status });
  return Response.json({ tokens: await listProjectTokens(member.workspace.id, member.madeBy) });
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
  const member = await loadWorkspaceForProjectTokens(request, params.workspaceHandle);
  if (!member.ok) return Response.json({ error: member.error }, { status: member.status });
  const { workspace, me, madeBy } = member;

  if (request.method === "POST") {
    let body: { label?: string } = {};
    try {
      body = (await request.json()) as { label?: string };
    } catch {
      // An empty body mints a token without a label.
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
  const revoked = await revokeProjectTokenById({
    workspace_id: workspace.id,
    token_suffix_id: id,
    created_by_user_id: madeBy,
  });
  return Response.json({ revoked });
}
