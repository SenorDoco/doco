// /<doco-handle>/integrations — per-Doco integrations INDEX.
//
//   Left  — what's connected to THIS Doco, one row per integration:
//           "Connected to <X>" + a Manage button into the integration's own
//           detail page (e.g. /integrations/github). This page stays a clean
//           index; the per-integration detail (repos, import status, actions)
//           lives on the standalone page.
//   Right — the catalog of integrations you can wire up at any level.
import { Link, useLoaderData } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { AvailableIntegrations, ScopeNavLinks } from "~/components/integrations-shell";
import { SiteHeader } from "~/components/site-header";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  buildInstallUrl,
  getDocoConnectionsContext,
  githubOrgAccounts,
} from "~/lib/github-connection.server";

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
  const orgAccounts = ctx
    ? githubOrgAccounts({ installations: ctx.installations, connections: ctx.connections })
    : [];
  return {
    me,
    handle: meta.handle,
    orgHandle: ctx?.orgHandle ?? "",
    docoInstallUrl,
    github: {
      connected: (ctx?.connections.length ?? 0) > 0 || orgAccounts.length > 0,
      orgAccounts,
      repoCount: ctx?.connections.length ?? 0,
      importing: ctx?.backfill?.status === "running",
    },
  };
}

export function meta({ params }: { params: { docoHandle: string } }) {
  return [{ title: `Integrations · ${params.docoHandle} · Doco` }];
}

const MANAGE_BTN =
  "neu-button inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";

export default function DocoIntegrations() {
  const { me, handle, orgHandle, docoInstallUrl, github } = useLoaderData<typeof loader>();

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
                        {github.importing ? ", importing…" : ""}.
                      </>
                    ) : (
                      <>
                        <span className="font-mono font-semibold text-foreground">
                          {github.repoCount}
                        </span>{" "}
                        {github.repoCount === 1 ? "repository" : "repositories"} connected
                        {github.importing ? ", importing…" : ""}.
                      </>
                    )}
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
