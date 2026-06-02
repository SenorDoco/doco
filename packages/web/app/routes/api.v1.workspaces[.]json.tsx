// GET  /api/v1/workspaces.json — list Workspaces the caller belongs to.
// POST /api/v1/workspaces.json — create an Workspace (v15).
//
// GET response: { workspaces: [{ id, handle, name, member_count }] }.
// Empty array when the caller is in no workspaces. Sorted by handle ASC
// for stable client rendering. A cookie session lists every workspace the
// caller belongs to; an OAuth bearer is narrowed to the workspaces the token
// can reach (granted workspaces ∪ workspaces that own a granted Doco) so a scoped
// token never enumerates the caller's other workspaces.
//
// POST body (JSON): { requested_id: string }
//
// POST behavior: caller becomes `owner` in `workspace_users`; server
// normalizes requested_id to kebab-case and silently appends `-2`,
// `-3`, … on collision (API path uses `autoSuffix: true`). Returns
// 201 with `{ id, handle }` — `id` is the internal ULID; `handle`
// is the (possibly suffixed) public identifier.
//
// Auth: requires a signed-in principal (cookie session or OAuth
// bearer). Rate-limiting is out of scope.

import { listWorkspacesForUser } from "@doco/db";
import { tokenReachableWorkspaceIdsForRequest } from "~/lib/doco-access.server";
import { addWorkspaceByHandle } from "~/lib/redeem.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const rows = await listWorkspacesForUser(me.id);
  // Cookie sessions see every membership workspace; an OAuth bearer is scoped
  // to the workspaces it can reach so a token can't enumerate the caller's
  // other workspaces.
  const reachable = await tokenReachableWorkspaceIdsForRequest(request);
  const visible = reachable ? rows.filter((r) => reachable.has(r.id)) : rows;
  visible.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  return Response.json({
    workspaces: visible.map((r) => ({
      id: r.id,
      handle: r.handle,
      name: r.name,
      member_count: r.member_count,
    })),
  });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }
  const requested = (body as { requested_id?: unknown })?.requested_id;
  if (typeof requested !== "string" || !requested.trim()) {
    return Response.json({ error: "`requested_id` is required (string)." }, { status: 400 });
  }
  try {
    const { id, handle } = await addWorkspaceByHandle({
      handle: requested.trim().toLowerCase(),
      ownerUserId: me.id,
      autoSuffix: true,
    });
    return Response.json({ id, handle }, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
