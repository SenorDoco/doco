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

/** List every Organization the signed-in principal has any role on. */
export async function listMyOrgs(principalId: string): Promise<MyOrgRow[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string }>(
      `SELECT o.id, COALESCE(o.handle, o.slug) AS handle
         FROM organizations o
        WHERE EXISTS (
          SELECT 1 FROM org_users m
           WHERE m.org_id = o.id AND m.collaborator_id = $1
        )
        ORDER BY handle`,
      [principalId],
    );
    return r.rows.map((row) => ({ id: String(row.id), handle: String(row.handle) }));
  });
}

/** Look up an org's public handle by its ULID. */
export async function lookupOrgHandle(orgId: string): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query<{ handle: string }>(
      `SELECT COALESCE(handle, slug) AS handle FROM organizations WHERE id = $1`,
      [orgId],
    );
    if ((r.rowCount ?? 0) === 0) return null;
    return String(r.rows[0]?.handle ?? "");
  });
}

/** True when the principal has any role on the org. */
export async function isOrgMember(orgId: string, principalId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT 1 FROM org_users WHERE org_id = $1 AND collaborator_id = $2 LIMIT 1",
      [orgId, principalId],
    );
    return (r.rowCount ?? 0) > 0;
  });
}
