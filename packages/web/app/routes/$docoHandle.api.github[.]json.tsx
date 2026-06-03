// Per-Doco GitHub connections API (list model). GET lists connections; POST
// takes an `intent`:
//   connect    — add a repo ("owner/name"/URL) + installation id (manual
//                fallback; the click-through setup callback is the main path).
//   disconnect — remove one repo's connection.
//   backfill   — import a connected repo's existing PRs as References.
// Writer access required for mutations; the Integrations panel posts here.
import { roleAtLeast } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { backfillRepoPullRequests } from "~/lib/github-backfill.server";
import {
  addConnection,
  getDocoConnectionsContext,
  listConnections,
  parseRepoSlug,
  removeConnection,
} from "~/lib/github-connection.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { meta } = await loadDocoRouteForRead(request, params);
  return Response.json({ ok: true, connections: await listConnections(meta.docoId) });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  const { me, meta } = await loadDocoRouteForRead(request, params, "writer");
  if (!me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const role = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!roleAtLeast(role, "writer")) {
    return Response.json({ error: "Forbidden: write access required." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const intent = String(body.intent ?? "");

  if (intent === "disconnect") {
    const parsed = parseRepoSlug(String(body.repo ?? ""));
    if (!parsed) {
      return Response.json(
        { error: 'repo must be "owner/name" or a GitHub URL.' },
        { status: 400 },
      );
    }
    const connections = await removeConnection(meta.docoId, `${parsed.owner}/${parsed.name}`);
    return Response.json({ ok: true, connections });
  }

  if (intent === "connect") {
    const parsed = parseRepoSlug(String(body.repo ?? ""));
    if (!parsed) {
      return Response.json(
        { error: 'repo must be "owner/name" or a GitHub URL.' },
        { status: 400 },
      );
    }
    const installationId = Number(body.installation_id);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return Response.json(
        { error: "installation_id must be a positive integer." },
        { status: 400 },
      );
    }
    const connections = await addConnection(meta.docoId, {
      repo: `${parsed.owner}/${parsed.name}`,
      installation_id: installationId,
      connected_at: new Date().toISOString(),
    });
    return Response.json({ ok: true, connections });
  }

  if (intent === "backfill") {
    const parsed = parseRepoSlug(String(body.repo ?? ""));
    if (!parsed) {
      return Response.json({ error: 'repo must be "owner/name".' }, { status: 400 });
    }
    const repo = `${parsed.owner}/${parsed.name}`;
    const ctx = await getDocoConnectionsContext(meta.docoId);
    const conn = ctx?.connections.find((c) => c.repo === repo);
    if (!ctx || !conn) {
      return Response.json({ error: "That repo isn't connected to this doco." }, { status: 400 });
    }
    const startPage = Number(body.page ?? 1);
    const result = await backfillRepoPullRequests({
      docoDir: docoPath(ctx.handle),
      docoId: meta.docoId,
      ownerSlug: ctx.workspaceHandle,
      docoSlug: ctx.handle,
      owner: parsed.owner,
      repo: parsed.name,
      installationId: conn.installation_id,
      createdByUserId: me.id,
      startPage: Number.isInteger(startPage) && startPage >= 1 ? startPage : 1,
    });
    return Response.json({ ok: true, repo, ...result });
  }

  return Response.json({ error: `Unknown intent: ${intent}` }, { status: 400 });
}
