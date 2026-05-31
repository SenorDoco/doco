// /orgs/:orgHandle/integrations — per-Org integrations management.
//
// Two panes:
//   Left  — integrations configured at the org level, plus a per-Doco
//           rollup for every Doco the org owns that has any connections.
//   Right — full catalog of available integrations; cross-scope clicks
//           land on the picker for the right target.
//
// Above both panes: a scope-nav link back up to the account-wide page.
//
// No org-level integrations exist as concrete features yet, so the left
// pane primarily surfaces the Docos-in-this-org rollup. The card slot
// for org-level integrations is wired so it lights up automatically the
// moment we add one (e.g. an org-level Slack channel default).
import { getOrgRole } from "@doco/db";
import { ArrowRight } from "lucide-react";
import { Link, redirect } from "react-router";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import {
  AvailableIntegrations,
  ScopeNavLinks,
  ScopePickerBanner,
} from "~/components/integrations-shell";
import { SiteHeader } from "~/components/site-header";
import { loadOrgIntegrationsRollup } from "~/lib/integrations-summary.server";
import { resolveOrgByHandle } from "~/lib/org-helpers.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { orgHandle: string };
}) {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  const org = await resolveOrgByHandle(params.orgHandle);
  if (!org) {
    throw new Response(`Org "${params.orgHandle}" not found.`, { status: 404 });
  }
  const role = await getOrgRole(org.id, me.id);
  if (!role) {
    throw new Response("You don't have access to this organization.", { status: 403 });
  }
  const rollup = await loadOrgIntegrationsRollup({ orgId: org.id, orgHandle: org.handle });
  return {
    me,
    org,
    rollup,
    pickingIntegrationId: url.searchParams.get("integration"),
  };
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `Integrations · ${params.orgHandle} · Doco` }];
}

export default function OrgIntegrations({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, org, rollup, pickingIntegrationId } = loaderData;
  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <Breadcrumb items={orgBreadcrumb({ orgSlug: org.handle, pageLabel: "Integrations" })} />
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            Everything wired up under {org.handle}, plus a rollup of each Doco&apos;s connections.
          </p>
          <ScopeNavLinks scope="org" />
        </header>

        <ScopePickerBanner
          integrationId={pickingIntegrationId}
          pageScope="org"
          orgHandle={org.handle}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Connected under {org.handle}
            </h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Org-level integrations</CardTitle>
                <CardDescription>Connections that apply to every Doco in this org.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No org-wide integrations are configured yet. Channel defaults from Slack and
                  similar org-scoped features will appear here.
                </p>
              </CardContent>
            </Card>

            <Card id="pick-doco">
              <CardHeader>
                <CardTitle className="text-base">Docos in this org</CardTitle>
                <CardDescription>
                  Each Doco manages its own connections. Open one to drill in.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {rollup.docos.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {rollup.docos.map((d) => (
                      <li
                        key={d.docoId}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <Link
                            to={`/${d.handle}/integrations`}
                            className="text-sm font-semibold text-foreground hover:text-primary"
                          >
                            {d.handle}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {d.githubRepoCount} GitHub repo{d.githubRepoCount === 1 ? "" : "s"}{" "}
                            connected
                          </p>
                        </div>
                        <Link
                          to={`/${d.handle}/integrations`}
                          className="neu-button inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:text-primary"
                        >
                          Manage
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-4 py-3 text-sm text-muted-foreground">
                    No Docos in this org have integrations configured yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Available integrations</h2>
            <AvailableIntegrations pageScope="org" orgHandle={org.handle} />
          </section>
        </div>
      </main>
    </div>
  );
}
