// /<doco-handle>/integrations/github — the standalone detail page for the
// GitHub connection. The Integrations page lists *what* is connected ("Connected
// to <org>" + a Manage button); the per-integration detail (covered repos,
// import progress, re-import / disconnect) lives here so the
// Integrations page stays a clean index. Until a repository is connected the
// page is the step that connects one (New Doco lands here for a GitHub Doco):
// pick repositories, or skip to the Doco. Connecting returns to the Doco,
// whose home shows the import filling it. What the Doco brings from its repos
// (pull requests, bugs for a GitHub bugs Doco, or code for a codebase Doco)
// follows its template (github-imports); the GitHub setup page picks it for a
// workspace.
//
// Writer-gated mutations (the connection model is a managed list).
import { roleAtLeast } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { Form, Link, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import {
  ActionNotice,
  GitHubSetupNotice,
  NEUTRAL_BTN,
  PRIMARY_BTN,
  RepositoryPicker,
  addableInstallationChoices,
  buildInstallationPickerChoices,
} from "~/components/github-repo-picker";
import { PageHeader } from "~/components/page-header";
import { docoPath } from "~/lib/db.server";
import {
  getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { type BackfillResult, repoBackfillFor } from "~/lib/github-backfill.server";
import {
  type GitHubBackfillState,
  type GitHubInstallationChoice,
  buildInstallUrl,
  connectRepositories,
  getDocoConnectionsContext,
  githubOrgAccounts,
  listGitHubInstallationChoicesForDocos,
  parseRepoSlug,
  pickConnections,
  reconcileInstallationConnections,
  removeConnection,
  resumeCursorFromConnections,
  setBackfillState,
  subscribeInstallation,
} from "~/lib/github-connection.server";
import {
  type GitHubImport,
  githubImportFor,
  refusedAccess,
  refusedAccessNote,
  skippedRepos,
} from "~/lib/github-imports";
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
  const docoInstallUrl = me
    ? buildInstallUrl({
        userId: me.id,
        docoIds: [meta.docoId],
        next: `/${meta.handle}/integrations/github`,
      })
    : null;
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
    handle: meta.handle,
    ownerSlug,
    workspaceHandle: ctx?.workspaceHandle ?? "",
    brings: githubImportFor(ctx?.template),
    canManage,
    docoInstallUrl,
    connections: ctx?.connections ?? [],
    installations: ctx?.installations ?? [],
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
    const picked = pickConnections(
      await listGitHubInstallationChoicesForDocos(await listAccessibleDocoIdsForPrincipal(me.id)),
      {
        repos: form.getAll("repo").map(String),
        installations: form.getAll("installation").map(String),
      },
    );
    if ("error" in picked) return picked;
    const connectedAt = new Date().toISOString();
    for (const choice of picked.installations) {
      await subscribeInstallation(meta.docoId, {
        installation_id: choice.installation_id,
        account: choice.account,
        connected_at: connectedAt,
      });
    }
    if (picked.connections.length > 0) {
      await connectRepositories(meta.docoId, picked.connections);
      waitUntil(kickBackfillRun(new URL(request.url).origin, meta.docoId));
    }
    // Back to the Doco, which shows the import's progress as it fills.
    throw redirect(`/${meta.handle}`);
  }

  if (intent === "backfill") {
    if (!parsed) return { error: "Invalid repo." };
    const repo = `${parsed.owner}/${parsed.name}`;
    const ctx = await getDocoConnectionsContext(meta.docoId);
    const conn = ctx?.connections.find((c) => c.repo === repo);
    if (!ctx || !conn) return { error: "That repo isn't connected." };
    // Runs synchronously in the request (one 500-item window). A GitHub failure
    // here — rate limit, a gone repo — must surface as a message, not a 500
    // error boundary; point the user at the background "Re-import all".
    try {
      const result = await repoBackfillFor(ctx.template)({
        docoDir: docoPath(ctx.handle),
        docoId: meta.docoId,
        ownerSlug: ctx.workspaceHandle,
        docoSlug: ctx.handle,
        owner: parsed.owner,
        repo: parsed.name,
        installationId: conn.installation_id,
        createdByUserId: me.id,
      });
      return { ok: true, sync: { repo, ...result } };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "GitHub request failed";
      return {
        error: `Couldn't re-import ${repo}: ${detail}. Use "${resyncButton(null, githubImportFor(ctx.template)).label}" to resume in the background.`,
      };
    }
  }

  if (intent === "resync-all") {
    // Recover a stalled / incomplete org import AND pick up repos added after
    // connect: re-discover the current repos of each organization subscribed as
    // a whole (records any missing ones), then rebuild the resumable cursor from
    // the now-complete connection list and kick the worker. Idempotent upserts
    // mean re-walking already-imported items just no-ops; gaps get filled. Kicked
    // off the request path so the form returns immediately and the "importing…"
    // banner takes over.
    const ctx0 = await getDocoConnectionsContext(meta.docoId);
    if (!ctx0 || (ctx0.connections.length === 0 && ctx0.installations.length === 0)) {
      return { error: "Nothing is connected to re-import." };
    }
    await reconcileInstallationConnections(meta.docoId, ctx0.installations);
    const ctx = (await getDocoConnectionsContext(meta.docoId)) ?? ctx0;
    if (ctx.connections.length === 0) return { error: "Nothing is connected to re-import." };
    await setBackfillState(meta.docoId, resumeCursorFromConnections(ctx.connections, ctx.backfill));
    waitUntil(kickBackfillRun(new URL(request.url).origin, meta.docoId));
    return {
      ok: true,
      message: `Re-importing ${githubImportFor(ctx.template).items} in the background…`,
    };
  }

  return { error: `Unknown action: ${intent}` };
}

/** Import outcome as a styled numeric summary (matches the overview cards). */
function SyncSummaryLine({ s, brings }: { s: SyncSummary; brings: GitHubImport }) {
  const parts: Array<{ n: number; label: string; color?: string }> = [
    { n: s.created, label: "new" },
    { n: s.updated, label: "updated" },
    { n: s.unchanged, label: "already current" },
    { n: s.failed, label: "failed", color: lifecycleColor("retired") },
  ].filter((p) => p.n > 0);
  return (
    <span className="text-foreground">
      Synced <span className="font-mono font-semibold tabular-nums">{s.total}</span>{" "}
      {s.total === 1 ? brings.item : brings.items} from <span className="font-mono">{s.repo}</span>
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
  return [{ title: `GitHub · App integrations · ${params.docoHandle} · Doco` }];
}

/**
 * Repositories an org-level ("all repositories") connection covers, for the
 * connected-account view. When a Doco subscribes to an installation rather than
 * picking repos, `connections` is empty — but the installation's live repo list
 * still rides along on the matching `installationChoices` entry. Surface those
 * so the connected account isn't a black box. Pure; de-duped + sorted.
 */
export function connectedOrgRepositories(
  installationChoices: GitHubInstallationChoice[],
  connectedInstallationIds: Set<number>,
): string[] {
  return [
    ...new Set(
      installationChoices
        .filter((choice) => connectedInstallationIds.has(choice.installation_id))
        .flatMap((choice) => choice.repositories),
    ),
  ].sort();
}

/**
 * The "Re-import all" recovery control. It is NEVER disabled: a stuck
 * "running" marker is the exact situation it exists to recover, so disabling it
 * while importing locked users out (the original bug). It stays clickable; only
 * its label changes to signal a restart while one is in flight. Pure.
 */
export function resyncButton(
  backfill: GitHubBackfillState | null,
  brings: Pick<GitHubImport, "items">,
): {
  label: string;
  disabled: boolean;
} {
  const running = backfill?.status === "running";
  return { label: running ? "Restart import" : `Re-import all ${brings.items}`, disabled: false };
}

/**
 * A short note naming the repositories the backfill had to skip (gone,
 * forbidden, or transient failures past the retry cap), so the gap is visible
 * instead of silent, and what GitHub needs when it refused Doco access. Null
 * when nothing was skipped. Pure.
 */
export function skippedReposNote(
  backfill: GitHubBackfillState | null,
  brings: Pick<GitHubImport, "items" | "permission">,
): string | null {
  const count = backfill ? skippedRepos(backfill) : 0;
  if (count === 0) return null;
  const errors = backfill?.errors ?? [];
  const repos = [...new Set(errors.map((e) => e.repo))];
  const shown = repos.slice(0, 3).join(", ");
  const unnamed = count - Math.min(repos.length, 3);
  const more = unnamed > 0 ? ` and ${unnamed} more` : "";
  const one = count === 1;
  const refused = refusedAccess({ errors }) ? ` ${refusedAccessNote(brings)}` : "";
  return `${count} ${one ? "repository" : "repositories"} couldn't be imported and ${
    one ? "was" : "were"
  } skipped: ${shown}${more}.${refused}`;
}

const DESTRUCTIVE_BTN =
  "neu-button rounded-md border border-border px-2.5 py-1 text-xs font-medium text-destructive hover:bg-input";

export default function DocoGitHubIntegration() {
  const {
    handle,
    ownerSlug,
    brings,
    canManage,
    docoInstallUrl,
    connections,
    installations,
    installationChoices,
    backfill,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const importing = backfill?.status === "running";
  const resync = resyncButton(backfill, brings);
  const skipped = skippedReposNote(backfill, brings);
  const connectedRepoSet = new Set(connections.map((connection) => connection.repo));
  const connectedInstallationIds = new Set(
    installations.map((installation) => installation.installation_id),
  );
  const subscribedAccounts = [...new Set(installations.map((i) => i.account))].sort();
  const connected = connections.length > 0 || installations.length > 0;
  const addableChoices = addableInstallationChoices(
    buildInstallationPickerChoices(installationChoices, connectedRepoSet, connectedInstallationIds),
  );
  const coveredOrgRepositories = connectedOrgRepositories(
    installationChoices,
    connectedInstallationIds,
  );

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      <PageHeader
        breadcrumb={docoBreadcrumb({
          ownerSlug,
          handle,
          parent: { label: "App integrations", to: `/${handle}/integrations` },
          pageLabel: "GitHub",
        })}
        title={connected ? "GitHub" : "Pick repositories"}
      >
        <p className="text-sm text-muted-foreground">
          <span className="font-mono text-foreground">{handle}</span> brings {brings.items} from{" "}
          {connected ? "these GitHub repositories" : "the GitHub repositories you pick"}.{" "}
          {brings.description}
          {connected ? null : " Nothing comes in until you connect at least one."}
        </p>
      </PageHeader>

      <GitHubSetupNotice outcome={searchParams.get("github")} />
      <ActionNotice
        data={actionData && ("error" in actionData || "message" in actionData) ? actionData : null}
      />
      {actionData && "ok" in actionData && "sync" in actionData ? (
        <p className="rounded-md border border-border bg-background p-3 text-sm">
          <SyncSummaryLine s={actionData.sync} brings={brings} />
        </p>
      ) : null}

      {connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connected repositories</CardTitle>
            <CardDescription>
              Repositories on GitHub this doco brings {brings.items} from.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {importing ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
                />
                <span>
                  Importing {brings.items}…
                  {backfill?.imported ? (
                    <>
                      {" "}
                      <span className="font-mono font-semibold tabular-nums">
                        {backfill.imported}
                      </span>{" "}
                      imported so far.
                    </>
                  ) : null}
                </span>
              </p>
            ) : null}
            {subscribedAccounts.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Connected to{" "}
                {subscribedAccounts.map((a, i) => (
                  <span key={a}>
                    {i > 0 ? ", " : ""}
                    <span className="font-mono font-semibold text-foreground">{a}</span>
                  </span>
                ))}{" "}
                — all repositories sync automatically, including ones added later.
              </p>
            ) : null}
            {connections.length > 0 ? (
              <ul className="divide-y divide-border rounded border border-border">
                {connections.map((c) => (
                  <li key={c.repo} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="font-mono text-sm">{c.repo}</span>
                    {canManage ? (
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
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : coveredOrgRepositories.length > 0 ? (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {coveredOrgRepositories.map((repo) => (
                  <li
                    key={repo}
                    className="min-w-0 truncate rounded border border-border bg-card px-2 py-1 font-mono text-xs"
                    title={repo}
                  >
                    {repo}
                  </li>
                ))}
              </ul>
            ) : null}
            {skipped ? (
              <p className="text-xs text-destructive">
                {skipped}
                {backfill && refusedAccess(backfill) && docoInstallUrl ? (
                  <>
                    {" "}
                    <a href={docoInstallUrl} className="font-semibold underline">
                      Review in GitHub
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {canManage && connections.length > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Import stuck or incomplete? Re-import walks every connected repo from the start —
                  already-imported {brings.items} are skipped.
                </p>
                <Form method="post">
                  <input type="hidden" name="intent" value="resync-all" />
                  <button
                    type="submit"
                    className={`shrink-0 ${PRIMARY_BTN}`}
                    disabled={resync.disabled}
                  >
                    {resync.label}
                  </button>
                </Form>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {canManage ? (
        <Card>
          {connected ? (
            <CardHeader>
              <CardTitle className="text-base">Add repositories</CardTitle>
            </CardHeader>
          ) : null}
          <CardContent className={connected ? undefined : "pt-5"}>
            <RepositoryPicker
              choices={addableChoices}
              installUrl={docoInstallUrl}
              aside={
                connected ? null : (
                  <Link
                    to={`/${handle}`}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Skip for now
                  </Link>
                )
              }
            />
          </CardContent>
        </Card>
      ) : connected ? null : (
        <p className="text-sm text-muted-foreground">
          No repositories are connected yet. A writer on this doco can connect them.
        </p>
      )}
    </main>
  );
}
