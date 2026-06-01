// /<doco-handle>/integrations — per-Doco integrations management.
//
// Two panes:
//   Left  — existing integrations on THIS Doco (GitHub repos today).
//   Right — full catalog of available integrations for any scope. Clicking
//           one whose scope matches this Doco starts the install flow; clicking
//           one whose scope is higher (account-level, etc.) jumps to the
//           matching scope page.
//
// Above both panes, scope-nav links surface the org-wide and account-wide
// integrations pages so a user can move between levels without going through
// breadcrumbs.
//
// Writer-gated mutations (matches the legacy /settings/integrations actions).
import { roleAtLeast } from "@doco/db";
import { Form, useActionData, useLoaderData, useSearchParams } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { AvailableIntegrations, ScopeNavLinks } from "~/components/integrations-shell";
import { SiteHeader } from "~/components/site-header";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { type BackfillResult, backfillRepoPullRequests } from "~/lib/github-backfill.server";
import {
  addConnection,
  buildInstallUrl,
  getDocoConnectionsContext,
  parseRepoSlug,
  removeConnection,
} from "~/lib/github-connection.server";
import { lifecycleColor } from "~/lib/node-colors";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { me, meta } = await loadDocoRouteForRead(request, params);
  const ctx = await getDocoConnectionsContext(meta.docoId);
  const docoInstallUrl = buildInstallUrl(meta.docoId);
  return {
    me,
    handle: meta.handle,
    orgHandle: ctx?.orgHandle ?? "",
    docoInstallUrl,
    connections: ctx?.connections ?? [],
  };
}

type SyncSummary = { repo: string } & BackfillResult;
type ActionResult =
  | { error: string }
  | { ok: true; message: string }
  | { ok: true; sync: SyncSummary };

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
    const rawPage = Number(form.get("page") ?? 1);
    const startPage = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
    const result = await backfillRepoPullRequests({
      docoDir: docoPath(ctx.handle),
      docoId: meta.docoId,
      ownerSlug: ctx.orgHandle,
      docoSlug: ctx.handle,
      owner: parsed.owner,
      repo: parsed.name,
      installationId: conn.installation_id,
      createdByUserId: me.id,
      startPage,
    });
    return { ok: true, sync: { repo, ...result } };
  }

  return { error: `Unknown action: ${intent}` };
}

/**
 * Import outcome as a styled numeric summary — the same `tabular-nums`
 * treatment the overview cards use, with the failure count tinted by the
 * retired lifecycle color. An idempotent re-sync reads "already current",
 * never "failed".
 */
function SyncSummaryLine({ s }: { s: SyncSummary }) {
  const parts: Array<{ n: number; label: string; color?: string }> = [
    { n: s.created, label: "new" },
    { n: s.updated, label: "updated" },
    { n: s.unchanged, label: "already current" },
    { n: s.failed, label: "failed", color: lifecycleColor("retired") },
  ].filter((p) => p.n > 0);
  return (
    <span className="text-foreground">
      Synced <span className="font-mono font-semibold tabular-nums">{s.total}</span>{" "}
      {s.total === 1 ? "PR" : "PRs"} from <span className="font-mono">{s.repo}</span>
      {parts.length > 0 ? (
        <>
          {" — "}
          {parts.map((p, i) => (
            <span key={p.label}>
              {i > 0 ? <span className="text-muted-foreground">, </span> : null}
              <span
                className="font-mono font-semibold tabular-nums"
                style={p.color ? { color: p.color } : undefined}
              >
                {p.n}
              </span>{" "}
              <span className="text-muted-foreground">{p.label}</span>
            </span>
          ))}
        </>
      ) : null}
      .
    </span>
  );
}

export function meta({ params }: { params: { docoHandle: string } }) {
  return [{ title: `Integrations · ${params.docoHandle} · Doco` }];
}

export default function DocoIntegrations() {
  const { me, handle, orgHandle, docoInstallUrl, connections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const flash = searchParams.get("github");

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <Breadcrumb items={docoBreadcrumb({ handle, pageLabel: "Integrations" })} />
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            What&apos;s connected to {handle}, and what else you can wire up at any level.
          </p>
          <ScopeNavLinks scope="doco" orgHandle={orgHandle} />
        </header>

        {flash === "connected" ? (
          <p className="rounded-md border border-border bg-background p-3 text-sm text-foreground">
            Connected —{" "}
            <span
              className="font-mono font-semibold tabular-nums"
              style={{ color: lifecycleColor("asserted") }}
            >
              {searchParams.get("count") ?? 0}
            </span>{" "}
            repo(s),{" "}
            <span
              className="font-mono font-semibold tabular-nums"
              style={{ color: lifecycleColor("asserted") }}
            >
              {searchParams.get("imported") ?? 0}
            </span>{" "}
            PR(s) imported. New repos in the org sync automatically.
          </p>
        ) : null}
        {flash === "forbidden" ? (
          <p className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            You need write access to connect this Doco.
          </p>
        ) : null}
        {flash === "setup_failed" ? (
          <p className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            GitHub setup didn&apos;t complete — check the App credentials (App ID and private key)
            in the deployment environment, then try Connect again.
          </p>
        ) : null}
        {flash === "signin_required" ? (
          <p className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            Sign in, then run Connect again.
          </p>
        ) : null}
        {actionData && "error" in actionData ? (
          <p className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            {actionData.error}
          </p>
        ) : null}
        {actionData && "ok" in actionData && "message" in actionData ? (
          <p className="rounded-md border border-border bg-background p-3 text-sm text-green-600">
            {actionData.message}
          </p>
        ) : null}
        {actionData && "ok" in actionData && "sync" in actionData ? (
          <div className="rounded-md border border-border bg-background p-3 text-sm space-y-2">
            <p>
              <SyncSummaryLine s={actionData.sync} />
            </p>
            {actionData.sync.nextPage != null ? (
              <Form method="post" className="flex items-center gap-2">
                <input type="hidden" name="intent" value="backfill" />
                <input type="hidden" name="repo" value={actionData.sync.repo} />
                <input type="hidden" name="page" value={actionData.sync.nextPage} />
                <button type="submit" className="rounded border px-2 py-1 text-xs">
                  Continue importing (page {actionData.sync.nextPage}+)
                </button>
                <span className="text-xs text-muted-foreground">More PRs remain</span>
              </Form>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Connected on this Doco</h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">GitHub repositories</CardTitle>
                <CardDescription>
                  New PRs sync automatically via webhook; existing PRs import on demand.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {connections.length > 0 ? (
                  <ul className="divide-y rounded border">
                    {connections.map((c) => (
                      <li
                        key={c.repo}
                        className="flex items-center justify-between gap-2 px-3 py-2"
                      >
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
                              className="rounded border px-2 py-1 text-xs text-destructive"
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
                {docoInstallUrl ? null : (
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
                      The one-click flow needs DOCO_GITHUB_APP_SLUG configured; until then, enter
                      the repo and App installation id.
                    </p>
                  </details>
                )}
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Available integrations</h2>
            <AvailableIntegrations
              pageScope="doco"
              orgHandle={orgHandle}
              docoHandle={handle}
              docoInstallUrl={docoInstallUrl}
            />
          </section>
        </div>
      </main>
    </div>
  );
}
