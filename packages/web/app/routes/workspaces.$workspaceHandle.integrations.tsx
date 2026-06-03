// /workspaces/:workspaceHandle/integrations — per-Workspace integrations management.
//
// Two panes:
//   Left  — integrations configured at the workspace level, plus a per-Doco
//           rollup for every Doco the workspace owns that has any connections.
//   Right — full catalog of available integrations; cross-scope clicks
//           land on the picker for the right target.
//
// Above both panes: a scope-nav link back up to the account-wide page.
//
// No workspace-level integrations exist as concrete features yet, so the left
// pane primarily surfaces the Docos-in-this-workspace rollup. The card slot
// for workspace-level integrations is wired so it lights up automatically the
// moment we add one (e.g. an workspace-level Slack channel default).
import { getWorkspaceRole } from "@doco/db";
import { ArrowRight } from "lucide-react";
import { redirect } from "react-router";
import { workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import {
  AvailableIntegrations,
  ConnectionList,
  ConnectionRow,
  ScopeNavLinks,
  ScopePickerBanner,
} from "~/components/integrations-shell";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadWorkspaceIntegrationsRollup } from "~/lib/integrations-summary.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { resolveWorkspaceByHandle } from "~/lib/workspace-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  const workspace = await resolveWorkspaceByHandle(params.workspaceHandle);
  if (!workspace) {
    throw new Response(`Workspace "${params.workspaceHandle}" not found.`, { status: 404 });
  }
  const role = await getWorkspaceRole(workspace.id, me.id);
  if (!role) {
    throw new Response("You don't have access to this workspace.", { status: 403 });
  }
  const rollup = await loadWorkspaceIntegrationsRollup({
    workspaceId: workspace.id,
    workspaceHandle: workspace.handle,
  });
  return {
    me,
    workspace,
    rollup,
    pickingIntegrationId: url.searchParams.get("integration"),
  };
}

export function meta({ params }: { params: { workspaceHandle: string } }) {
  return [{ title: `App integrations · ${params.workspaceHandle} · Doco` }];
}

export default function WorkspaceIntegrations({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, workspace, rollup, pickingIntegrationId } = loaderData;
  return (
    <div>
      <SiteHeader me={me} />
      <SingleColumnPageMain className="space-y-6 py-6">
        <PageHeader
          breadcrumb={workspaceBreadcrumb({
            workspaceSlug: workspace.handle,
            pageLabel: "App integrations",
          })}
          title="App integrations"
        >
          <div className="space-y-3 pt-1">
            <p className="text-sm text-muted-foreground">
              Everything wired up under {workspace.handle}, plus a rollup of each Doco&apos;s
              connections.
            </p>
            <ScopeNavLinks scope="workspace" />
          </div>
        </PageHeader>

        <ScopePickerBanner
          integrationId={pickingIntegrationId}
          pageScope="workspace"
          workspaceHandle={workspace.handle}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Connected under {workspace.handle}
            </h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Workspace-level integrations</CardTitle>
                <CardDescription>
                  Connections that apply to every Doco in this workspace.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No workspace-wide integrations are configured yet. Channel defaults from Slack and
                  similar workspace-scoped features will appear here.
                </p>
              </CardContent>
            </Card>

            <Card id="pick-doco">
              <CardHeader>
                <CardTitle className="text-base">Docos in this workspace</CardTitle>
                <CardDescription>
                  Each Doco manages its own connections. Open one to drill in.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {rollup.docos.length > 0 ? (
                  <ConnectionList>
                    {rollup.docos.map((d) => (
                      <ConnectionRow
                        key={d.docoId}
                        title={d.handle}
                        titleHref={`/${d.handle}/integrations`}
                        detail={`${d.githubRepoCount} GitHub repo${
                          d.githubRepoCount === 1 ? "" : "s"
                        } connected`}
                        action={{
                          label: "Manage",
                          href: `/${d.handle}/integrations`,
                          icon: ArrowRight,
                        }}
                      />
                    ))}
                  </ConnectionList>
                ) : (
                  <p className="px-4 py-3 text-sm text-muted-foreground">
                    No Docos in this workspace have integrations configured yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Available integrations</h2>
            <AvailableIntegrations pageScope="workspace" workspaceHandle={workspace.handle} />
          </section>
        </div>
      </SingleColumnPageMain>
    </div>
  );
}
