// v15: route-helpers that wrap @doco/db so route files don't need to
// import `withClient` directly. The `.server.ts` suffix tells
// react-router to strip this entire chain from the client bundle.
//
// Anything that runs raw SQL against `workspaces` or `workspace_users`
// from a route loader/action lives here.

import { type DocoRole, getWorkspaceRole, withClient } from "@doco/db";
import { type ReadableWorkspaceDoco, listReadableDocosInWorkspace } from "./doco-access.server";

export interface MyWorkspaceRow {
  id: string;
  handle: string;
}

export interface WorkspacePublicRow {
  id: string;
  handle: string;
  name: string;
  /**
   * Workspace's governing charter — the standing "how work is done here" text
   * shown on the workspace home page and shared with agents granted access to
   * the workspace at bootstrap. Empty string only if explicitly cleared.
   */
  constitution: string;
}

/** List every Workspace the signed-in user has any role on. */
export async function listMyWorkspaces(userId: string): Promise<MyWorkspaceRow[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string }>(
      `SELECT o.id, o.handle
         FROM workspaces o
        WHERE EXISTS (
          SELECT 1 FROM workspace_users m
           WHERE m.workspace_id = o.id AND m.user_id = $1
        )
        ORDER BY handle`,
      [userId],
    );
    return r.rows.map((row) => ({ id: String(row.id), handle: String(row.handle) }));
  });
}

export interface WorkspaceForRead {
  /** The constitution is workspace-member content: blank for non-members. */
  workspace: WorkspacePublicRow;
  myRole: DocoRole | null;
  /** Only the Docos the caller may read (see `listReadableDocosInWorkspace`). */
  docos: ReadableWorkspaceDoco[];
}

/**
 * Resolve a workspace page for `principalId`. A caller who is not a member and
 * can read none of its Docos gets the same 404 as a missing workspace, so the
 * page is not an oracle for which private workspaces exist.
 */
export async function loadWorkspaceForRead(
  workspaceHandle: string,
  principalId: string | null,
): Promise<WorkspaceForRead> {
  const notFound = new Response(`Workspace "${workspaceHandle}" not found.`, { status: 404 });
  const workspace = await resolveWorkspaceByHandle(workspaceHandle);
  if (!workspace) throw notFound;
  const myRole = principalId ? await getWorkspaceRole(workspace.id, principalId) : null;
  const docos = await listReadableDocosInWorkspace(workspace.id, principalId);
  if (!myRole && docos.length === 0) throw notFound;
  return {
    workspace: myRole ? workspace : { ...workspace, constitution: "" },
    myRole,
    docos,
  };
}

/** Look up an workspace's public handle by its ULID. */
export async function lookupWorkspaceHandle(workspaceId: string): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query<{ handle: string }>("SELECT handle FROM workspaces WHERE id = $1", [
      workspaceId,
    ]);
    if ((r.rowCount ?? 0) === 0) return null;
    return String(r.rows[0]?.handle ?? "");
  });
}

export async function resolveWorkspaceByHandle(
  workspaceHandle: string,
): Promise<WorkspacePublicRow | null> {
  return withClient(async (c) => {
    const r = await c.query<{
      id: string;
      handle: string;
      name: string;
      constitution: string;
    }>(
      `SELECT id, handle, name, constitution FROM workspaces
        WHERE handle = $1
        LIMIT 1`,
      [workspaceHandle],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      handle: String(row.handle),
      name: String(row.name),
      constitution:
        row.constitution === null || row.constitution === undefined ? "" : String(row.constitution),
    };
  });
}

/** True when the user has any role on the workspace. */
export async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT 1 FROM workspace_users WHERE workspace_id = $1 AND user_id = $2 LIMIT 1",
      [workspaceId, userId],
    );
    return (r.rowCount ?? 0) > 0;
  });
}
