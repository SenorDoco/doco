// Gate for the hosted MCP endpoint at `/mcp`.
//
// One durable credential reaches all of a user's workspaces, but each access
// token is single-workspace — minted per session via the actor→access exchange
// with an RFC 8707 `resource` (see oauth-server.server.ts). So the token's lone
// `granted_workspace_ids[0]` IS this session's workspace, and we confine every
// tool to it exactly as the legacy per-workspace endpoint does — just resolved
// from the token instead of the URL path.

import { getWorkspaceById } from "@doco/db";
import { getOauthTokenForRequest } from "./doco-access.server";
import { getCurrentPrincipalAsync } from "./session.server";
import { type WorkspaceMcpGate, principalReachesWorkspace } from "./workspace-mcp.server";

export async function gateUserMcp(request: Request): Promise<WorkspaceMcpGate> {
  const principal = await getCurrentPrincipalAsync(request);
  if (!principal) return { ok: false, kind: "unauthenticated", message: "Unauthorized" };

  // The user-level endpoint is bearer-only: identity comes from the access
  // token. (A cookie session can't pin a session here.)
  const token = await getOauthTokenForRequest(request);
  if (!token) return { ok: false, kind: "unauthenticated", message: "Unauthorized" };

  // An "act as me" (actor) token reaches EVERY workspace the human belongs to,
  // not one: it carries no stored workspace. Enter all-workspaces mode; tools
  // resolve Docos globally and the access gate enforces the live, capped role
  // per call. `list_workspaces` lets the agent discover what it can reach.
  if (token.grant_type === "actor") {
    return {
      ok: true,
      ctx: { workspaceId: "", workspaceHandle: "", principalId: principal.id, allWorkspaces: true },
    };
  }

  const workspaceId = (token.granted_workspace_ids ?? [])[0];
  if (!workspaceId) {
    return {
      ok: false,
      kind: "forbidden",
      message:
        "This token isn't scoped to a workspace. Re-authenticate requesting exactly one workspace (the RFC 8707 `resource`), then retry.",
    };
  }

  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return { ok: false, kind: "not_found", message: `Workspace "${workspaceId}" not found.` };
  }

  // Defense in depth: the human behind the token must still reach this
  // workspace right now (membership can be revoked after a token is minted).
  if (!(await principalReachesWorkspace(principal.id, workspaceId))) {
    return { ok: false, kind: "forbidden", message: "You don't have access to this workspace." };
  }

  return {
    ok: true,
    ctx: { workspaceId, workspaceHandle: workspace.handle, principalId: principal.id },
  };
}
