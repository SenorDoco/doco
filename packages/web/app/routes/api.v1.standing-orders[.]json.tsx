// GET /api/v1/standing-orders.json — what always applies in one workspace,
// read once at the start of a session (lib/brief/standing-orders.server): the
// constitution, the active rules, a line per Doco on what it holds and
// expects, and what changed since `since` (default: the last 7 days).
// `workspace` names the workspace by handle; `format=text` returns the text
// rendering alone.
//
// Auth: a project token (its workspace, as the person who made it reads it;
// `workspace` may only name that one) or a signed-in principal (cookie or
// OAuth bearer) who names a workspace they are a member of or can read a Doco
// of; either reads its constitution. 401 when no caller resolves, 400 without
// a workspace. Each read is one query of the workspace in the query log.

import { withClient } from "@doco/db";
import { getPublicBaseUrl } from "@doco/shared";
import { waitUntil } from "@vercel/functions";
import { composeStandingOrders } from "~/lib/brief/standing-orders.server";
import { isProjectToken, validateProjectToken } from "~/lib/project-tokens.server";
import { recordQuery } from "~/lib/query-log.server";
import { extractBearer, getCurrentPrincipalAsync } from "~/lib/session.server";
import { loadWorkspaceForRead, lookupWorkspaceHandle } from "~/lib/workspace-helpers.server";

export const config = { maxDuration: 30 };

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const wanted = url.searchParams.get("workspace")?.trim() || null;
  const since = url.searchParams.get("since")?.trim() || null;
  const format = url.searchParams.get("format") === "text" ? "text" : "json";

  const bearer = extractBearer(request);
  const projectToken = bearer && isProjectToken(bearer) ? await validateProjectToken(bearer) : null;
  const me = projectToken ? null : await getCurrentPrincipalAsync(request);
  if (!projectToken && !me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  let workspace = wanted;
  if (projectToken) {
    const handle = await lookupWorkspaceHandle(projectToken.workspace_id);
    if (!handle || (wanted && wanted !== handle && wanted !== projectToken.workspace_id)) {
      return Response.json(
        { error: "Project token is scoped to a different workspace." },
        { status: 403 },
      );
    }
    workspace = handle;
  }
  if (!workspace) {
    return Response.json({ error: "Name the workspace (workspace=<handle>)." }, { status: 400 });
  }
  // A project token reads as the person who made it.
  const read = await loadWorkspaceForRead(
    workspace,
    projectToken ? projectToken.created_by_user_id : (me as { id: string }).id,
  );
  const scope = { workspaceId: read.workspace.id, docoIds: read.docos.map((d) => d.id) };

  const orders = await withClient((c) =>
    composeStandingOrders(c, { ...scope, origin: getPublicBaseUrl(request) }, { since }),
  );
  if (!orders) return Response.json({ error: "Workspace not found." }, { status: 404 });
  waitUntil(
    recordQuery(request, { workspaceId: scope.workspaceId, docoId: null }, me?.id ?? null, {
      standing_orders: true,
      rules: orders.rules.length,
      changes: orders.changes.items.length,
      tokens: orders.tokens,
    }),
  );
  if (format === "text") {
    return new Response(orders.text, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return Response.json(orders);
}
