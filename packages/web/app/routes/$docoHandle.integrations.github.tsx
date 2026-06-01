// /<doco-handle>/integrations/github — the standalone detail page for the
// GitHub connection. The Integrations page lists *what* is connected ("Connected
// to <org>" + a Manage button); the per-integration detail (covered repos,
// import progress, re-import / disconnect, manual connect) lives here so the
// Integrations page stays a clean index.
//
// Writer-gated mutations (the connection model is a managed list).
import { roleAtLeast } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { ArrowUpRight, Github, Plus } from "lucide-react";
import { useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { docoPath } from "~/lib/db.server";
import {
  getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { type BackfillResult, backfillRepoPullRequests } from "~/lib/github-backfill.server";
import {
  type GitHubInstallationChoice,
  addConnection,
  buildInstallUrl,
  getDocoConnectionsContext,
  githubOrgAccounts,
  listGitHubInstallationChoicesForDocos,
  parseRepoSlug,
  reconcileInstallationConnections,
  removeConnection,
  resumeCursorFromConnections,
  setBackfillState,
} from "~/lib/github-connection.server";
import { lifecycleColor } from "~/lib/node-colors";
import { kickBackfillRun } from "./api.github.backfill-run";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { me, meta, ownerSlug } = await loadDocoRouteForRead(request, params);
  const ctx = await getDocoConnectionsContext(meta.docoId);
  const docoInstallUrl = buildInstallUrl(meta.docoId);
  const role = me
    ? await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id)
    : null;
  const canManage = roleAtLeast(role, "writer");
  const accessibleDocoIds = me ? await listAccessibleDocoIdsForPrincipal(me.id) : [];
  const installationChoices = me
    ? await listGitHubInstallationChoicesForDocos(accessibleDocoIds)
    : [];
  const connectedHere = (ctx?.connections.length ?? 0) > 0 || (ctx?.installations.length ?? 0) > 0;

  if (canManage && !connectedHere && installationChoices.length === 0 && docoInstallUrl) {
    throw redirect(docoInstallUrl);
  }

  return {
    me,
    handle: meta.handle,
    ownerSlug,
    orgHandle: ctx?.orgHandle ?? "",
    canManage,
    docoInstallUrl,
    connections: ctx?.connections ?? [],
    installationChoices,
    orgAccounts: ctx
      ? githubOrgAccounts({ installations: ctx.installations, connections: ctx.connections })
      : [],
    backfill: ctx?.backfill ?? null,
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

  if (intent === "connect-existing-repos") {
    const installationId = Number(form.get("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return { error: "Choose a GitHub organization first." };
    }
    const requestedRepos = [
      ...new Set(
        form
          .getAll("repo")
          .map((repo) => String(repo).trim())
          .filter(Boolean),
      ),
    ];
    if (requestedRepos.length === 0) return { error: "Pick at least one repository." };

    const choices = await listGitHubInstallationChoicesForDocos(
      await listAccessibleDocoIdsForPrincipal(me.id),
    );
    const choice = choices.find((c) => c.installation_id === installationId);
    if (!choice) return { error: "That GitHub connection is not available to your account." };
    const allowedRepos = new Set(choice.repositories);
    const repos: string[] = [];
    for (const repoInput of requestedRepos) {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) return { error: `Invalid repo: ${repoInput}` };
      const repo = `${parsedRepo.owner}/${parsedRepo.name}`;
      if (!allowedRepos.has(repo)) {
        return { error: `${repo} is not available from the selected GitHub connection.` };
      }
      repos.push(repo);
    }

    const connectedAt = new Date().toISOString();
    for (const repo of repos) {
      await addConnection(meta.docoId, {
        repo,
        installation_id: installationId,
        connected_at: connectedAt,
      });
    }
    await setBackfillState(meta.docoId, {
      status: "running",
      started_at: connectedAt,
      repos: repos.length,
      installation_id: installationId,
      queue: repos,
      repo_index: 0,
      page: 1,
      imported: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      cursor_at: connectedAt,
    });
    waitUntil(kickBackfillRun(new URL(request.url).origin, meta.docoId));
    return {
      ok: true,
      message: `Connecting ${repos.length} ${repos.length === 1 ? "repository" : "repositories"} and importing pull requests in the background…`,
    };
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
    return { ok: true, sync: { repo, ...result } };
  }

  if (intent === "resync-all") {
    // Recover a stalled / incomplete org import AND pick up repos added after
    // connect: re-discover each installation's current repos (records any
    // missing ones), then rebuild the resumable cursor from the now-complete
    // connection list and kick the worker. Idempotent upserts mean re-walking
    // already-imported PRs just no-ops; gaps get filled. Kicked off the request
    // path so the form returns immediately and the "importing…" banner takes over.
    const ctx0 = await getDocoConnectionsContext(meta.docoId);
    if (!ctx0 || (ctx0.connections.length === 0 && ctx0.installations.length === 0)) {
      return { error: "Nothing is connected to re-import." };
    }
    await reconcileInstallationConnections(meta.docoId, ctx0);
    const ctx = (await getDocoConnectionsContext(meta.docoId)) ?? ctx0;
    if (ctx.connections.length === 0) return { error: "Nothing is connected to re-import." };
    await setBackfillState(meta.docoId, resumeCursorFromConnections(ctx.connections, ctx.backfill));
    waitUntil(kickBackfillRun(new URL(request.url).origin, meta.docoId));
    return { ok: true, message: "Re-importing pull requests in the background…" };
  }

  return { error: `Unknown action: ${intent}` };
}

/** Import outcome as a styled numeric summary (matches the overview cards). */
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
  return [{ title: `GitHub · Integrations · ${params.docoHandle} · Doco` }];
}

export type InstallationPickerChoice = GitHubInstallationChoice & {
  selectableRepositories: string[];
  connectedRepositories: string[];
  hasSelectableRepositories: boolean;
};

export function buildInstallationPickerChoices(
  choices: GitHubInstallationChoice[],
  connectedRepos: Set<string>,
): InstallationPickerChoice[] {
  return choices.map((choice) => {
    const connectedRepositories = choice.repositories.filter((repo) => connectedRepos.has(repo));
    const selectableRepositories = choice.repositories.filter((repo) => !connectedRepos.has(repo));
    return {
      ...choice,
      selectableRepositories,
      connectedRepositories,
      hasSelectableRepositories: selectableRepositories.length > 0,
    };
  });
}

// Doco's raised "neu-button" affordance — primary (filled) and neutral variants.
const PRIMARY_BTN =
  "neu-button inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-55";
const NEUTRAL_BTN =
  "neu-button rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-input hover:text-foreground";
const DESTRUCTIVE_BTN =
  "neu-button rounded-md border border-border px-2.5 py-1 text-xs font-medium text-destructive hover:bg-input";

export default function DocoGitHubIntegration() {
  const {
    me,
    handle,
    ownerSlug,
    canManage,
    docoInstallUrl,
    connections,
    installationChoices,
    orgAccounts,
    backfill,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const flash = searchParams.get("github");
  const importing = backfill?.status === "running" || flash === "importing";
  const connectedRepoSet = new Set(connections.map((connection) => connection.repo));
  const pickerChoices = buildInstallationPickerChoices(installationChoices, connectedRepoSet);
  const hasSelectableRepositories = pickerChoices.some(
    (choice) => choice.hasSelectableRepositories,
  );

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <Breadcrumb
          items={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: "Integrations", to: `/${handle}/integrations` },
            pageLabel: "GitHub",
          })}
        />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">GitHub</h1>
          <p className="text-sm text-muted-foreground">
            Pull requests from connected repositories are tracked as References on {handle}.
          </p>
        </header>

        {importing ? (
          <p className="flex items-center gap-2 rounded-md border border-border bg-background p-3 text-sm text-foreground">
            <span
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
            />
            <span>
              Importing pull requests in the background
              {backfill?.repos ? (
                <>
                  {" "}
                  —{" "}
                  <span className="font-mono font-semibold tabular-nums">
                    {Math.min((backfill.repo_index ?? 0) + 1, backfill.repos)}
                  </span>
                  {" / "}
                  <span className="font-mono font-semibold tabular-nums">{backfill.repos}</span>{" "}
                  repo(s)
                  {backfill.imported ? (
                    <>
                      ,{" "}
                      <span className="font-mono font-semibold tabular-nums">
                        {backfill.imported}
                      </span>{" "}
                      imported so far
                    </>
                  ) : null}
                </>
              ) : null}{" "}
              — you can keep working; they'll appear as they sync, and new repos in the org sync
              automatically.
            </span>
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
        {!importing && flash === "connected" ? (
          <p className="rounded-md border border-border bg-background p-3 text-sm text-foreground">
            GitHub is connected.{" "}
            {hasSelectableRepositories
              ? "Choose the repositories to connect to this Doco."
              : "No repositories are available yet; add repositories in GitHub to make them selectable here."}
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
          <p className="rounded-md border border-border bg-background p-3 text-sm">
            <SyncSummaryLine s={actionData.sync} />
          </p>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Choose repositories</CardTitle>
            <CardDescription>
              {pickerChoices.length > 0
                ? "Select one or more repositories for this Doco."
                : "No GitHub repositories are selected for this Doco yet."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {canManage && pickerChoices.length > 0 ? (
              <ExistingGitHubPicker choices={pickerChoices} docoInstallUrl={docoInstallUrl} />
            ) : null}
            {orgAccounts.length > 0 && connections.length > 0 ? (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                <p className="text-foreground">
                  GitHub connected to{" "}
                  {orgAccounts.map((a, i) => (
                    <span key={a}>
                      {i > 0 ? ", " : ""}
                      <span className="font-mono font-semibold">{a}</span>
                    </span>
                  ))}
                  .
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-mono font-semibold tabular-nums">{connections.length}</span>{" "}
                  {connections.length === 1 ? "repository is" : "repositories are"} selected for
                  this Doco.
                </p>
              </div>
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
                        <button type="submit" className={NEUTRAL_BTN}>
                          Re-import
                        </button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="disconnect" />
                        <input type="hidden" name="repo" value={c.repo} />
                        <button type="submit" className={DESTRUCTIVE_BTN}>
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
            {connections.length > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Import stuck or incomplete? Re-import walks every connected repo from the start —
                  already-imported PRs are skipped.
                </p>
                <Form method="post">
                  <input type="hidden" name="intent" value="resync-all" />
                  <button type="submit" className={`shrink-0 ${PRIMARY_BTN}`} disabled={importing}>
                    {importing ? "Importing…" : "Re-import all PRs"}
                  </button>
                </Form>
              </div>
            ) : null}
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
                  <button type="submit" className={PRIMARY_BTN}>
                    Connect
                  </button>
                </Form>
                <p className="mt-1 text-xs text-muted-foreground">
                  The one-click flow needs DOCO_GITHUB_APP_SLUG configured; until then, enter the
                  repo and App installation id.
                </p>
              </details>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function ExistingGitHubPicker({
  choices,
  docoInstallUrl,
}: {
  choices: InstallationPickerChoice[];
  docoInstallUrl: string | null;
}) {
  return (
    <section className="space-y-3 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Github className="h-4 w-4 text-primary" aria-hidden="true" />
            Repositories
          </h2>
        </div>
        {docoInstallUrl ? (
          <a
            href={docoInstallUrl}
            className="neu-button inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-foreground hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add repositories in GitHub
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <div className="space-y-3">
        {choices.map((choice) => (
          <InstallationChoiceForm key={choice.installation_id} choice={choice} />
        ))}
      </div>
    </section>
  );
}

function InstallationChoiceForm({ choice }: { choice: InstallationPickerChoice }) {
  const [selectedCount, setSelectedCount] = useState(0);

  return (
    <Form
      method="post"
      className="space-y-3"
      onChange={(event) => {
        setSelectedCount(event.currentTarget.querySelectorAll('input[name="repo"]:checked').length);
      }}
    >
      <input type="hidden" name="intent" value="connect-existing-repos" />
      <input type="hidden" name="installation_id" value={choice.installation_id} />
      <div className="space-y-2 rounded-md border border-border/80 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-mono text-sm font-semibold text-foreground">{choice.account}</p>
            {choice.repositories_unavailable ? (
              <p className="text-[11px] text-muted-foreground">Showing known repositories only.</p>
            ) : null}
          </div>
          {choice.hasSelectableRepositories ? (
            <button type="submit" className={PRIMARY_BTN} disabled={selectedCount === 0}>
              {selectedCount > 0
                ? `Connect ${selectedCount} ${selectedCount === 1 ? "repo" : "repos"}`
                : "Select repos"}
            </button>
          ) : null}
        </div>
        {choice.selectableRepositories.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {choice.selectableRepositories.map((repo) => (
              <label
                key={repo}
                className="flex min-w-0 items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-xs"
              >
                <input
                  type="checkbox"
                  name="repo"
                  value={repo}
                  className="h-3.5 w-3.5 shrink-0 accent-primary"
                />
                <span className="min-w-0 flex-1 truncate font-mono" title={repo}>
                  {repo}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No repositories are available from this GitHub organization yet.
          </p>
        )}
        {choice.connectedRepositories.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Already connected:{" "}
            <span className="font-mono">{choice.connectedRepositories.join(", ")}</span>
          </p>
        ) : null}
      </div>
    </Form>
  );
}
