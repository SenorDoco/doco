// Workspace-bound MCP access gate.
//
// The hosted remote MCP endpoint is per-workspace: `/<workspace-id>/mcp`
// (decision: no app-wide MCP). A token may reach AT MOST one workspace
// (assertSingleWorkspaceGrant), so this gate is what guarantees the endpoint
// only ever serves the workspace named in its URL: a token minted for
// workspace A cannot drive workspace B's MCP, and every tool call is
// constrained to Docos owned by this workspace.
//
// The gate returns a discriminated result rather than throwing, so the route
// can shape the right transport response (401 + WWW-Authenticate for
// unauthenticated, 404 for an unknown workspace, 403 for a wrong-workspace
// token).

import { getDocoByIdOrHandle, getWorkspaceById, getWorkspaceRole, withClient } from "@doco/db";
import { getOauthTokenForRequest } from "./doco-access.server";
import type { ValidAccessToken } from "./oauth-server.server";
import { getCurrentPrincipalAsync } from "./session.server";

export interface WorkspaceMcpContext {
  workspaceId: string;
  workspaceHandle: string;
  principalId: string;
  /** Actor "act as me" mode: reach every workspace the human belongs to (the
   * app-wide `/mcp` with an actor token). `workspaceId`/`Handle` are empty. */
  allWorkspaces?: boolean;
}

export type WorkspaceMcpGate =
  | { ok: true; ctx: WorkspaceMcpContext }
  | { ok: false; kind: "unauthenticated" | "not_found" | "forbidden"; message: string };

/**
 * Gate a request to a per-workspace MCP endpoint. Order matters:
 *   1. authenticated? (else the connector must run OAuth)
 *   2. is `workspaceId` a real workspace? (else 404)
 *   3. if a bearer token is attached, does it reach THIS workspace? A
 *      single-workspace token for another workspace is refused here — this is
 *      the boundary that keeps one workspace's MCP from touching another's.
 *   4. can the underlying principal reach this workspace at all? (member, or
 *      a per-Doco grant inside it) — so a token can never widen past its human.
 */
export async function gateWorkspaceMcp(
  request: Request,
  workspaceId: string,
): Promise<WorkspaceMcpGate> {
  const principal = await getCurrentPrincipalAsync(request);
  if (!principal) return { ok: false, kind: "unauthenticated", message: "Unauthorized" };

  const workspace = workspaceId.startsWith("workspace_")
    ? await getWorkspaceById(workspaceId)
    : null;
  if (!workspace) {
    return { ok: false, kind: "not_found", message: `Workspace "${workspaceId}" not found.` };
  }

  const token = await getOauthTokenForRequest(request);
  if (token && !(await tokenReachesWorkspace(token, workspaceId))) {
    return {
      ok: false,
      kind: "forbidden",
      message:
        "This token is not authorized for this workspace. A token is bound to a single workspace; re-authorize against this workspace's MCP endpoint.",
    };
  }

  if (!(await principalReachesWorkspace(principal.id, workspaceId))) {
    return { ok: false, kind: "forbidden", message: "You don't have access to this workspace." };
  }

  return {
    ok: true,
    ctx: { workspaceId, workspaceHandle: workspace.handle, principalId: principal.id },
  };
}

/** True if the token grants this workspace directly, or via a Doco it owns. */
async function tokenReachesWorkspace(
  token: ValidAccessToken,
  workspaceId: string,
): Promise<boolean> {
  // An actor token acts as the human — it carries no stored grants, so its
  // reach is the human's membership (verified by principalReachesWorkspace).
  if (token.grant_type === "actor") return true;
  if ((token.granted_workspace_ids ?? []).includes(workspaceId)) return true;
  const docoIds = (token.granted_doco_ids ?? []).filter((id) => id && id !== "*");
  if (docoIds.length === 0) return false;
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT 1 FROM docos WHERE owner_id = $1 AND id = ANY($2::text[]) AND deleted_at IS NULL LIMIT 1",
      [workspaceId, docoIds],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

/** True if the principal is a workspace member or holds a Doco grant inside it. */
export async function principalReachesWorkspace(
  principalId: string,
  workspaceId: string,
): Promise<boolean> {
  if (await getWorkspaceRole(workspaceId, principalId)) return true;
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM doco_users du
         JOIN docos d ON d.id = du.doco_id
        WHERE d.owner_id = $1 AND du.user_id = $2 AND d.deleted_at IS NULL
        LIMIT 1`,
      [workspaceId, principalId],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

export type DocoInWorkspace = { ok: true; handle: string } | { ok: false; message: string };

/**
 * Resolve a tool's `doco` argument (handle or id) and confirm it belongs to
 * THIS workspace. A Doco in another workspace is refused — the endpoint is
 * bound to one workspace, so its tools never reach outside it.
 */
export async function resolveDocoInWorkspace(
  handleOrId: string,
  workspaceId: string,
): Promise<DocoInWorkspace> {
  const doco = await getDocoByIdOrHandle(handleOrId);
  if (!doco) return { ok: false, message: `Doco "${handleOrId}" not found.` };
  if (doco.owner_id !== workspaceId) {
    return {
      ok: false,
      message: `Doco "${handleOrId}" is not in this workspace. This MCP endpoint only serves Docos in ${workspaceId}.`,
    };
  }
  return { ok: true, handle: doco.handle };
}
