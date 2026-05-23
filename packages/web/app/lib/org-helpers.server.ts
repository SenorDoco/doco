// v15: route-helpers that wrap @doco/db so route files don't need to
// import `withClient` directly. The `.server.ts` suffix tells
// react-router to strip this entire chain from the client bundle.
//
// Anything that runs raw SQL against `organizations` or `org_users`
// from a route loader/action lives here.

import { withClient } from "@doco/db";

export interface MyOrgRow {
  id: string;
  handle: string;
}

export interface OrgPublicRow {
  id: string;
  handle: string;
  name: string;
}

/** List every Organization the signed-in collaborator has any role on. */
export async function listMyOrgs(collaboratorId: string): Promise<MyOrgRow[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string }>(
      `SELECT o.id, o.handle
         FROM organizations o
        WHERE EXISTS (
          SELECT 1 FROM org_users m
           WHERE m.org_id = o.id AND m.collaborator_id = $1
        )
        ORDER BY handle`,
      [collaboratorId],
    );
    return r.rows.map((row) => ({ id: String(row.id), handle: String(row.handle) }));
  });
}

/** Look up an org's public handle by its ULID. */
export async function lookupOrgHandle(orgId: string): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query<{ handle: string }>("SELECT handle FROM organizations WHERE id = $1", [
      orgId,
    ]);
    if ((r.rowCount ?? 0) === 0) return null;
    return String(r.rows[0]?.handle ?? "");
  });
}

export async function resolveOrgByHandle(orgHandle: string): Promise<OrgPublicRow | null> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; name: string }>(
      `SELECT id, handle, name FROM organizations
        WHERE handle = $1
        LIMIT 1`,
      [orgHandle],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      handle: String(row.handle),
      name: String(row.name),
    };
  });
}

/** True when the collaborator has any role on the org. */
export async function isOrgMember(orgId: string, collaboratorId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT 1 FROM org_users WHERE org_id = $1 AND collaborator_id = $2 LIMIT 1",
      [orgId, collaboratorId],
    );
    return (r.rowCount ?? 0) > 0;
  });
}
