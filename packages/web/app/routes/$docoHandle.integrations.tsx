// /<doco-handle>/integrations — per-Doco integrations INDEX.
//
//   Left  — what's connected to THIS Doco, one row per integration:
//           "Connected to <X>" + a Manage button into the integration's own
//           detail page (e.g. /integrations/github). This page stays a clean
//           index; the per-integration detail (repos, import status, actions)
//           lives on the standalone page.
//   Right — the catalog of integrations you can wire up at any level.
import { useEffect, useRef } from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { AvailableIntegrations, ScopeNavLinks } from "~/components/integrations-shell";
import { SiteHeader } from "~/components/site-header";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  type GitHubImportProgress,
  buildInstallUrl,
  getDocoConnectionsContext,
  githubImportProgress,
  githubOrgAccounts,
} from "~/lib/github-connection.server";

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
  const orgAccounts = ctx
    ? githubOrgAccounts({ installations: ctx.installations, connections: ctx.connections })
    : [];
  return {
    me,
    handle: meta.handle,
    ownerSlug,
    workspaceHandle: ctx?.workspaceHandle ?? "",
    docoInstallUrl,
    github: {
      connected: (ctx?.connections.length ?? 0) > 0 || orgAccounts.length > 0,
      orgAccounts,
      repoCount: ctx?.connections.length ?? 0,
      importing: ctx?.backfill?.status === "running",
      importProgress: githubImportProgress(ctx?.backfill ?? null),
    },
  };
}

export function meta({ params }: { params: { docoHandle: string } }) {
  return [{ title: `Integrations · ${params.docoHandle} · Doco` }];
}

const MANAGE_BTN =
  "neu-button inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";

/**
 * Animated "importing X of Y…" note shown on the GitHub card while a PR
 * backfill runs: the running repo count plus a spinner. Falls back to a plain
 * "importing…" with just the spinner when the repo total isn't known yet.
 */
export function ImportingNote({ progress }: { progress: GitHubImportProgress | null }) {
  return (
    <>
      , importing
      {progress ? (
        <>
          {" "}
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {progress.done}
          </span>
          {" of "}
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {progress.total}
          </span>
        </>
      ) : null}{" "}
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent align-middle"
      />
    </>
  );
}

export default function DocoIntegrations() {
  const { me, handle, ownerSlug, workspaceHandle, docoInstallUrl, github } =
    useLoaderData<typeof loader>();

  // While a PR backfill is running, poll the loader so the "importing X of Y"
  // count climbs on its own — mirrors the live-feed polling on the Doco home
  // (ADR-089). The ref keeps a fresh revalidator without re-arming the interval
  // every render; the interval exists only while importing and tears down once
  // the import finishes (importing flips false → effect cleanup).
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    if (!github.importing) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && revalidatorRef.current.state === "idle") {
        revalidatorRef.current.revalidate();
      }
    }, 4000);
    return () => clearInterval(id);
  }, [github.importing]);

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto w-full max-w-6xl space-y-6 px-6 py-6">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Integrations" })} />
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            What&apos;s connected to {handle}, and what else you can wire up at any level.
          </p>
          <ScopeNavLinks scope="doco" workspaceHandle={workspaceHandle} />
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Connected on this Doco</h2>
            {github.connected ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">GitHub</CardTitle>
                  <CardDescription>
                    {github.orgAccounts.length > 0 ? (
                      <>
                        Connected to{" "}
                        {github.orgAccounts.map((a, i) => (
                          <span key={a}>
                            {i > 0 ? ", " : ""}
                            <span className="font-mono font-semibold text-foreground">{a}</span>
                          </span>
                        ))}{" "}
                        — {github.repoCount}{" "}
                        {github.repoCount === 1 ? "repository" : "repositories"}
                      </>
                    ) : (
                      <>
                        <span className="font-mono font-semibold text-foreground">
                          {github.repoCount}
                        </span>{" "}
                        {github.repoCount === 1 ? "repository" : "repositories"} connected
                      </>
                    )}
                    {github.importing ? <ImportingNote progress={github.importProgress} /> : "."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Pull requests tracked as References.
                  </p>
                  <Link to={`/${handle}/integrations/github`} className={MANAGE_BTN}>
                    Manage
                  </Link>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-6 text-sm text-muted-foreground">
                  Nothing connected yet. Wire up an integration from the catalog →
                </CardContent>
              </Card>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Available integrations</h2>
            <AvailableIntegrations
              pageScope="doco"
              workspaceHandle={workspaceHandle}
              docoHandle={handle}
              docoInstallUrl={docoInstallUrl}
            />
          </section>
        </div>
      </main>
    </div>
  );
}
