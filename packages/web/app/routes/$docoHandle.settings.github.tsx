// Settings panel for the GitHub integration: connect a repo, import previous
// PRs, or disconnect. A thin UI over the same helpers the JSON API and webhook
// use (docos.data.github_integration). Writer access required for mutations.
import { roleAtLeast } from "@doco/db";
import { Form, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
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
  return { handle: meta.handle, connection: ctx?.connection ?? null };
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
  if (!me) return { error: "Sign in to manage the GitHub connection." };
  const role = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!roleAtLeast(role, "writer")) {
    return { error: "Write access is required to manage the GitHub connection." };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "disconnect") {
    await clearGitHubConnection(meta.docoId);
    return { ok: true, message: "Disconnected from GitHub." };
  }

  if (intent === "connect") {
    const parsed = parseRepoSlug(String(form.get("repo") ?? ""));
    if (!parsed) return { error: 'Enter a repo as "owner/name" or a GitHub URL.' };
    const installationId = Number(form.get("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return { error: "Installation ID must be a positive number." };
    }
    await setGitHubConnection(meta.docoId, {
      repo: `${parsed.owner}/${parsed.name}`,
      installation_id: installationId,
      connected_at: new Date().toISOString(),
    });
    return { ok: true, message: `Connected to ${parsed.owner}/${parsed.name}.` };
  }

  if (intent === "backfill") {
    const ctx = await getDocoGitHubContext(meta.docoId);
    if (!ctx?.connection) return { error: "Connect a repo first." };
    const parsed = parseRepoSlug(ctx.connection.repo);
    if (!parsed) return { error: "Stored repo is malformed; reconnect." };
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
    return {
      ok: true,
      message: `Imported ${result.imported} of ${result.total} PRs${
        result.failed ? ` (${result.failed} failed)` : ""
      }.`,
    };
  }

  return { error: `Unknown action: ${intent}` };
}

export default function GitHubSettings() {
  const { connection } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>GitHub integration</CardTitle>
          <CardDescription>
            Connect a repository so its pull requests are tracked as References. New PRs sync
            automatically via webhook; existing PRs import on demand.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {actionData && "error" in actionData ? (
            <p className="text-sm text-red-600">{actionData.error}</p>
          ) : null}
          {actionData && "ok" in actionData ? (
            <p className="text-sm text-green-600">{actionData.message}</p>
          ) : null}

          {connection ? (
            <div className="space-y-3">
              <p className="text-sm">
                Connected to <span className="font-mono">{connection.repo}</span> (installation{" "}
                {connection.installation_id}).
              </p>
              <div className="flex gap-2">
                <Form method="post">
                  <input type="hidden" name="intent" value="backfill" />
                  <button
                    type="submit"
                    className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                  >
                    Import previous PRs
                  </button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="disconnect" />
                  <button type="submit" className="rounded border px-3 py-1.5 text-sm">
                    Disconnect
                  </button>
                </Form>
              </div>
            </div>
          ) : (
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="connect" />
              <label className="block text-sm">
                Repository
                <input
                  name="repo"
                  placeholder="owner/name"
                  required
                  className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-sm">
                App installation ID
                <input
                  name="installation_id"
                  type="number"
                  required
                  className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              >
                Connect
              </button>
            </Form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
