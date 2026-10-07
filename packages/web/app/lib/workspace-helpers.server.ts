// v15: route-helpers that wrap @doco/db so route files don't need to
// import `withClient` directly. The `.server.ts` suffix tells
// react-router to strip this entire chain from the client bundle.
//
// Anything that runs raw SQL against `workspaces` or `workspace_users`
// from a route loader/action lives here.

import { type DocoRole, getWorkspaceRole, withClient } from "@doco/db";
import { type ReadableWorkspaceDoco, listReadableDocosInWorkspace } from "./doco-access.server";
import { createDocoInWorkspace } from "./redeem.server";
import { type CurrentPrincipal, getCurrentPrincipalAsync } from "./session.server";

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
  /** With its constitution: whoever reads a Doco of the workspace reads it (decision_01M3Z5SXF1VZ4N6DSE5AVVZ41N). */
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
  return { workspace, myRole, docos };
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

/**
 * The workspace's Doco made from `template`: its oldest live one, or a new one
 * created by `userId` as `<workspace>-<handleSuffix>` when it has none. A
 * source of knowledge (a GitHub import, Slack, Notion) fills one this way.
 */
export async function ensureWorkspaceDoco(opts: {
  workspace: { id: string; handle: string };
  template: string;
  handleSuffix: string;
  userId: string;
}): Promise<{ id: string; handle: string; visibility: "public" | "private" }> {
  const existing = await withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; visibility: "public" | "private" }>(
      `SELECT id, handle, visibility FROM docos
        WHERE workspace_id = $1 AND deleted_at IS NULL AND data->>'template_handle' = $2
        ORDER BY created_at, id
        LIMIT 1`,
      [opts.workspace.id, opts.template],
    );
    return r.rows[0];
  });
  if (existing) return existing;
  const created = await createDocoInWorkspace({
    workspaceId: opts.workspace.id,
    requestedHandle: `${opts.workspace.handle}-${opts.handleSuffix}`
      .slice(0, 64)
      .replace(/-+$/, ""),
    createdByUserId: opts.userId,
    templateHandle: opts.template,
    autoSuffix: true,
  });
  return { id: created.docoId, handle: created.handle, visibility: "private" };
}

/**
 * The workspace behind a handle and the caller as one of its members, for its
 * hook tokens: an owner sees and revokes everyone's (`madeBy` null), any
 * other member their own; otherwise the status and the reason.
 */
export async function loadWorkspaceForHookTokens(
  request: Request,
  workspaceHandle: string,
): Promise<
  | { ok: true; workspace: WorkspacePublicRow; me: CurrentPrincipal; madeBy: string | null }
  | { ok: false; status: 401 | 403 | 404; error: string }
> {
  const workspace = await resolveWorkspaceByHandle(workspaceHandle);
  if (!workspace) {
    return { ok: false, status: 404, error: `Workspace "${workspaceHandle}" not found.` };
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!me) return { ok: false, status: 401, error: "Sign in to manage your hook tokens." };
  const role = await getWorkspaceRole(workspace.id, me.id);
  if (!role) {
    return { ok: false, status: 403, error: "Only members of this workspace have hook tokens." };
  }
  return { ok: true, workspace, me, madeBy: role === "owner" ? null : me.id };
}
