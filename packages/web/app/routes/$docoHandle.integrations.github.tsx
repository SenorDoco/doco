// /<doco-handle>/integrations/github — the standalone detail page for the
// GitHub connection. The Integrations page lists *what* is connected ("Connected
// to <org>" + a Manage button); the per-integration detail (covered repos,
// import progress, re-import / disconnect) lives here so the
// Integrations page stays a clean index. What the Doco brings from its repos
// (pull requests, or bugs for a Bug tracker) follows its template
// (github-imports); the GitHub setup page picks it for a workspace.
//
// Writer-gated mutations (the connection model is a managed list).
import { roleAtLeast } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { ArrowUpRight, Github, Plus } from "lucide-react";
import { Form, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import {
  ActionNotice,
  GitHubImportStarted,
  GitHubSetupNotice,
  InstallationChoiceForm,
  type InstallationPickerChoice,
  NEUTRAL_BTN,
  PRIMARY_BTN,
  addableInstallationChoices,
  buildInstallationPickerChoices,
} from "~/components/github-repo-picker";
import { PageHeader } from "~/components/page-header";
import { SiteHeader } from "~/components/site-header";
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
  pickRepositories,
  reconcileInstallationConnections,
  removeConnection,
  resumeCursorFromConnections,
  setBackfillState,
  subscribeInstallation,
} from "~/lib/github-connection.server";
import { type GitHubImport, githubImportFor } from "~/lib/github-imports";
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
    me,
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

  if (intent === "connect-existing-repos") {
    const installationId = Number(form.get("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return { error: "Choose a GitHub organization first." };
    }
    const choices = await listGitHubInstallationChoicesForDocos(
      await listAccessibleDocoIdsForPrincipal(me.id),
    );
    const choice = choices.find((c) => c.installation_id === installationId);
    if (!choice) return { error: "That GitHub connection is not available to your account." };
    const picked = pickRepositories(
      choice,
      form.getAll("repo").map((repo) => String(repo)),
    );
    if ("error" in picked) return picked;
    const { repos } = picked;

    await connectRepositories(meta.docoId, installationId, repos);
    waitUntil(kickBackfillRun(new URL(request.url).origin, meta.docoId));
    // Hand the user a standalone "import started" screen (PRG redirect) rather
    // than an inline banner — one clear confirmation, one way forward.
    throw redirect(`/${meta.handle}/integrations/github?github=importing&count=${repos.length}`);
  }

  if (intent === "connect-installation") {
    const installationId = Number(form.get("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return { error: "Choose a GitHub organization first." };
    }

    const choices = await listGitHubInstallationChoicesForDocos(
      await listAccessibleDocoIdsForPrincipal(me.id),
    );
    const choice = choices.find((c) => c.installation_id === installationId);
    if (!choice) return { error: "That GitHub connection is not available to your account." };
    if (choice.repository_selection !== "all") {
      return { error: "Choose at least one repository from this GitHub connection." };
    }

    await subscribeInstallation(meta.docoId, {
      installation_id: installationId,
      account: choice.account,
      connected_at: new Date().toISOString(),
    });
    const { item } = githubImportFor((await getDocoConnectionsContext(meta.docoId))?.template);
    return {
      ok: true,
      message: `Connected ${choice.account}. New ${item} activity will sync automatically.`,
    };
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
    // connect: re-discover each installation's current repos (records any
    // missing ones), then rebuild the resumable cursor from the now-complete
    // connection list and kick the worker. Idempotent upserts mean re-walking
    // already-imported items just no-ops; gaps get filled. Kicked off the request
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
 * instead of silent. Null when nothing was skipped. Pure.
 */
export function skippedReposNote(backfill: GitHubBackfillState | null): string | null {
  const repos = [...new Set((backfill?.errors ?? []).map((e) => e.repo))];
  if (repos.length === 0) return null;
  const shown = repos.slice(0, 3).join(", ");
  const more = repos.length > 3 ? ` and ${repos.length - 3} more` : "";
  const one = repos.length === 1;
  return `${repos.length} ${one ? "repository" : "repositories"} couldn't be imported and ${
    one ? "was" : "were"
  } skipped: ${shown}${more}.`;
}

const DESTRUCTIVE_BTN =
  "neu-button rounded-md border border-border px-2.5 py-1 text-xs font-medium text-destructive hover:bg-input";

export default function DocoGitHubIntegration() {
  const {
    me,
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
  const flash = searchParams.get("github");
  const importing = backfill?.status === "running";
  const resync = resyncButton(backfill, brings);
  const skipped = skippedReposNote(backfill);
  const connectedRepoSet = new Set(connections.map((connection) => connection.repo));
  const connectedInstallationIds = new Set(
    installations.map((installation) => installation.installation_id),
  );
  const subscribedAccounts = [...new Set(installations.map((i) => i.account))].sort();
  // Section 2 lists only what's still addable.
  const addableChoices = addableInstallationChoices(
    buildInstallationPickerChoices(installationChoices, connectedRepoSet, connectedInstallationIds),
  );
  const coveredOrgRepositories = connectedOrgRepositories(
    installationChoices,
    connectedInstallationIds,
  );

  if (flash === "importing") {
    return (
      <GitHubImportStarted
        me={me}
        count={Number(searchParams.get("count") ?? 0)}
        docos={[{ handle, items: brings.items }]}
      />
    );
  }

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <PageHeader
          breadcrumb={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: "App integrations", to: `/${handle}/integrations` },
            pageLabel: "GitHub",
          })}
          title="GitHub"
        >
          <p className="text-sm text-muted-foreground">
            {brings.label} from connected repositories come into {handle}: {brings.description}
          </p>
        </PageHeader>

        <GitHubSetupNotice outcome={flash} />
        <ActionNotice
          data={
            actionData && ("error" in actionData || "message" in actionData) ? actionData : null
          }
        />
        {actionData && "ok" in actionData && "sync" in actionData ? (
          <p className="rounded-md border border-border bg-background p-3 text-sm">
            <SyncSummaryLine s={actionData.sync} brings={brings} />
          </p>
        ) : null}

        {/* Section 1 — the repositories this doco is connected to on GitHub. */}
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
            ) : subscribedAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No repositories connected yet.</p>
            ) : null}
            {skipped ? <p className="text-xs text-destructive">{skipped}</p> : null}
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

        {/* Section 2 — every repo Doco can see, to add more (writers only). */}
        {canManage ? (
          <AddMoreRepositories choices={addableChoices} docoInstallUrl={docoInstallUrl} />
        ) : null}
      </main>
    </div>
  );
}

function AddMoreRepositories({
  choices,
  docoInstallUrl,
}: {
  choices: InstallationPickerChoice[];
  docoInstallUrl: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Github className="h-4 w-4 text-primary" aria-hidden="true" />
              Add more repositories
            </CardTitle>
            <CardDescription>
              Repositories you&apos;ve granted Doco access to. Pick the ones to track on this doco.
            </CardDescription>
          </div>
          {docoInstallUrl ? (
            <a
              href={docoInstallUrl}
              className="neu-button inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-foreground hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add organizations or repositories in GitHub
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {choices.length > 0 ? (
          choices.map((choice) => (
            <InstallationChoiceForm key={choice.installation_id} choice={choice} />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            {docoInstallUrl
              ? "Every repository Doco can see is already connected. Grant access to more organizations or repositories in GitHub to track additional ones."
              : "No additional repositories are available to add."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
