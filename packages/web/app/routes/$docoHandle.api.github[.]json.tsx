// Per-Doco GitHub connection API. GET reports connection status; POST takes an
// `intent`:
//   connect    — wire a repo ("owner/name" or URL) + App installation id into
//                docos.data.github_integration (the webhook + backfill read it).
//   disconnect — clear it.
//   backfill   — import the connected repo's existing PRs as References (the
//                "Import previous PRs?" action).
// Writer access required for mutations; the settings panel posts here.
import { roleAtLeast } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { backfillRepoPullRequests } from "~/lib/github-backfill.server";
import {
  clearGitHubConnection,
  getDocoGitHubContext,
  parseRepoSlug,
  setGitHubConnection,
} from "~/lib/github-connection.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { meta } = await loadDocoRouteForRead(request, params);
  const ctx = await getDocoGitHubContext(meta.docoId);
  return Response.json({
    ok: true,
    connected: Boolean(ctx?.connection),
    connection: ctx?.connection ?? null,
  });
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
    await clearGitHubConnection(meta.docoId);
    return Response.json({ ok: true, connected: false });
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
    const repo = `${parsed.owner}/${parsed.name}`;
    await setGitHubConnection(meta.docoId, {
      repo,
      installation_id: installationId,
      connected_at: new Date().toISOString(),
    });
    return Response.json({ ok: true, connected: true, repo });
  }

  if (intent === "backfill") {
    const ctx = await getDocoGitHubContext(meta.docoId);
    if (!ctx?.connection) {
      return Response.json({ error: "No GitHub repo connected." }, { status: 400 });
    }
    const parsed = parseRepoSlug(ctx.connection.repo);
    if (!parsed) {
      return Response.json({ error: "Stored repo is malformed." }, { status: 400 });
    }
    const result = await backfillRepoPullRequests({
      docoDir: docoPath(ctx.handle),
      docoId: meta.docoId,
      ownerSlug: ctx.orgHandle,
      docoSlug: ctx.handle,
      owner: parsed.owner,
      repo: parsed.name,
      installationId: ctx.connection.installation_id,
      createdByUserId: me.id,
    });
    return Response.json({ ok: true, ...result });
  }

  return Response.json({ error: `Unknown intent: ${intent}` }, { status: 400 });
}
