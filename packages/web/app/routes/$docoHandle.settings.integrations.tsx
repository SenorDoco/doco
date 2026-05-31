// Integrations section. Today: GitHub — connect repositories (one-click via the
// App install flow when DOCO_GITHUB_APP_SLUG is set, else a manual fallback),
// then manage each connection (re-import / disconnect). A thin UI over the same
// list helpers the JSON API + webhook + backfill use. Writer-gated mutations.
import { roleAtLeast } from "@doco/db";
import { Form, useActionData, useLoaderData, useSearchParams } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { backfillRepoPullRequests } from "~/lib/github-backfill.server";
import {
  addConnection,
  buildInstallUrl,
  getDocoConnectionsContext,
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
  const ctx = await getDocoConnectionsContext(meta.docoId);
  return {
    handle: meta.handle,
    connections: ctx?.connections ?? [],
    installUrl: buildInstallUrl(meta.docoId),
  };
}

type ActionResult = { error: string } | { ok: true; message: string };

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}): Promise<ActionResult> {
  const { me, meta } = await loadDocoRouteForRead(request, params, "writer");
  if (!me) return { error: "Sign in to manage integrations." };
  const role = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!roleAtLeast(role, "writer")) return { error: "Write access is required." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const parsed = parseRepoSlug(String(form.get("repo") ?? ""));

  if (intent === "disconnect") {
    if (!parsed) return { error: "Invalid repo." };
    await removeConnection(meta.docoId, `${parsed.owner}/${parsed.name}`);
    return { ok: true, message: `Disconnected ${parsed.owner}/${parsed.name}.` };
  }

  if (intent === "connect") {
    if (!parsed) return { error: 'Enter a repo as "owner/name" or a GitHub URL.' };
    const installationId = Number(form.get("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return { error: "Installation ID must be a positive number." };
    }
    await addConnection(meta.docoId, {
      repo: `${parsed.owner}/${parsed.name}`,
      installation_id: installationId,
      connected_at: new Date().toISOString(),
    });
    return { ok: true, message: `Connected ${parsed.owner}/${parsed.name}.` };
  }

  if (intent === "backfill") {
    if (!parsed) return { error: "Invalid repo." };
    const repo = `${parsed.owner}/${parsed.name}`;
    const ctx = await getDocoConnectionsContext(meta.docoId);
    const conn = ctx?.connections.find((c) => c.repo === repo);
    if (!ctx || !conn) return { error: "That repo isn't connected." };
    const result = await backfillRepoPullRequests({
      docoDir: docoPath(ctx.handle),
      docoId: meta.docoId,
      ownerSlug: ctx.orgHandle,
      docoSlug: ctx.handle,
      owner: parsed.owner,
      repo: parsed.name,
      installationId: conn.installation_id,
      createdByUserId: me.id,
    });
    return {
      ok: true,
      message: `Imported ${result.imported} of ${result.total} PRs from ${repo}${
        result.failed ? ` (${result.failed} failed)` : ""
      }.`,
    };
  }

  return { error: `Unknown action: ${intent}` };
}

export default function Integrations() {
  const { connections, installUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const flash = searchParams.get("github");

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-4 text-xl font-semibold">Integrations</h1>
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Connect repositories so their pull requests are tracked as References. New PRs sync
            automatically via webhook; existing PRs import on demand.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {flash === "connected" ? (
            <p className="text-sm text-green-600">
              Connected — {searchParams.get("count") ?? 0} repo(s) imported.
            </p>
          ) : null}
          {flash === "forbidden" ? (
            <p className="text-sm text-red-600">You need write access to connect this Doco.</p>
          ) : null}
          {flash === "setup_failed" ? (
            <p className="text-sm text-red-600">
              GitHub setup didn&apos;t complete — check the App credentials (App ID and private key)
              in the deployment environment, then try Connect again.
            </p>
          ) : null}
          {flash === "signin_required" ? (
            <p className="text-sm text-red-600">Sign in, then run Connect again.</p>
          ) : null}
          {actionData && "error" in actionData ? (
            <p className="text-sm text-red-600">{actionData.error}</p>
          ) : null}
          {actionData && "ok" in actionData ? (
            <p className="text-sm text-green-600">{actionData.message}</p>
          ) : null}

          {connections.length > 0 ? (
            <ul className="divide-y rounded border">
              {connections.map((c) => (
                <li key={c.repo} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="font-mono text-sm">{c.repo}</span>
                  <span className="flex gap-2">
                    <Form method="post">
                      <input type="hidden" name="intent" value="backfill" />
                      <input type="hidden" name="repo" value={c.repo} />
                      <button type="submit" className="rounded border px-2 py-1 text-xs">
                        Re-import
                      </button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="disconnect" />
                      <input type="hidden" name="repo" value={c.repo} />
                      <button
                        type="submit"
                        className="rounded border px-2 py-1 text-xs text-red-600"
                      >
                        Disconnect
                      </button>
                    </Form>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No repositories connected yet.</p>
          )}

          {installUrl ? (
            <a
              href={installUrl}
              className="inline-block rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            >
              Connect a GitHub repository
            </a>
          ) : (
            <details className="text-sm">
              <summary className="cursor-pointer">Connect a repository (manual)</summary>
              <Form method="post" className="mt-2 space-y-2">
                <input type="hidden" name="intent" value="connect" />
                <input
                  name="repo"
                  placeholder="owner/name"
                  required
                  className="block w-full rounded border px-2 py-1 text-sm"
                />
                <input
                  name="installation_id"
                  type="number"
                  placeholder="App installation ID"
                  required
                  className="block w-full rounded border px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                >
                  Connect
                </button>
              </Form>
              <p className="mt-1 text-xs text-muted-foreground">
                The one-click flow needs DOCO_GITHUB_APP_SLUG configured; until then, enter the repo
                and App installation id.
              </p>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
