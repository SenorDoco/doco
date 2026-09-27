// Shared helpers for the hosted MCP endpoint (`/mcp`, gated by gateUserMcp).
//
// The gate result shape (`WorkspaceMcpGate`) and two confinement helpers live
// here: `resolveDocoInWorkspace` constrains a tool's `doco` argument to a Doco
// owned by the session's workspace, and `principalReachesWorkspace` checks live
// membership. Both are used by the user-level gate and the route handler.
//
// The gate returns a discriminated result rather than throwing, so the route
// can shape the right transport response (401 + WWW-Authenticate for
// unauthenticated, 404 for an unknown workspace, 403 for a forbidden token).

import { getDocoByIdOrHandle, getWorkspaceRole, withClient } from "@doco/db";

export interface WorkspaceMcpContext {
  workspaceId: string;
  workspaceHandle: string;
  principalId: string;
  /** Actor "all workspaces" mode: reach every workspace the human belongs to (the
   * app-wide `/mcp` with an actor token). `workspaceId`/`Handle` are empty. */
  allWorkspaces?: boolean;
}

export type WorkspaceMcpGate =
  | { ok: true; ctx: WorkspaceMcpContext }
  | { ok: false; kind: "unauthenticated" | "not_found" | "forbidden"; message: string };

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
