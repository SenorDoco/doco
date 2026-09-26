// GET /api/v1/workspaces.json — list Workspaces the caller can reach.
//
// Response: { workspaces: [{ id, handle, name, member_count }] }. Empty array
// when the caller is in no workspaces. Sorted by handle ASC for stable client
// rendering. A cookie session lists every workspace the caller belongs to; an
// OAuth bearer is narrowed to the workspaces the token can reach (granted
// workspaces ∪ workspaces that own a granted Doco) so a scoped token never
// enumerates the caller's other workspaces.
//
// There is deliberately no POST. People create Workspaces at /new-workspace;
// agents are granted access to Workspaces that already exist (all of a user's,
// one, or a subset of its Docos). A POST answers 405 with that pointer so an
// agent that guesses the old create call learns the access model instead of a
// bare method error.
//
// Auth: requires a signed-in principal (cookie session or OAuth bearer).

import { listWorkspacesForUser } from "@doco/db";
import { tokenReachableWorkspaceIdsForRequest } from "~/lib/doco-access.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const rows = await listWorkspacesForUser(me.id);
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

export function action({ request }: { request: Request }) {
  const host = new URL(request.url).origin;
  return Response.json(
    {
      error: `Workspaces are created by people, not agents. Ask the user to create it at ${host}/new-workspace and grant you access (all their workspaces, one workspace, or specific Docos), then GET this endpoint to find it.`,
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
