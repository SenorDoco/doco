// /workspaces/:workspaceHandle/integrations — per-Workspace integrations management.
//
// Two panes:
//   Left  — integrations configured at the workspace level, plus a per-Doco
//           rollup for every Doco the workspace owns that has any connections.
//   Right — full catalog of available integrations. "Set up..." on a
//           Doco-level one (GitHub, Notion) reopens this page with a picker of
//           the workspace's Docos on top.
//
// Above both panes: a scope-nav link back up to the account-wide page.
//
// The Docos-in-this-workspace rollup sits alongside the workspace-level
// integrations card, which is now where Slack lives: Slack is workspace-scoped
// (one team binds to one workspace), so this is its management home — the same
// way GitHub is managed on the Doco it's connected to. The account page only
// links here.
import { getWorkspaceRole } from "@doco/db";
import { ArrowRight } from "lucide-react";
import { redirect } from "react-router";
import { workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import {
  AvailableIntegrations,
  ConnectionList,
  ConnectionRow,
  DocoPickerCard,
  RemoveSlackButton,
  ScopeNavLinks,
} from "~/components/integrations-shell";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadDocoPicker, loadWorkspaceIntegrationsRollup } from "~/lib/integrations-summary.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { listSlackInstallations } from "~/lib/slack.server";
import { resolveWorkspaceByHandle } from "~/lib/workspace-helpers.server";

/** A Slack team bound to this workspace, trimmed to what the card renders. */
interface WorkspaceSlackTeam {
  teamId: string;
  teamName: string;
  installedAt: string;
}

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
  const slack: WorkspaceSlackTeam[] = (await listSlackInstallations())
    .filter((install) => install.docoWorkspaceId === workspace.id)
    .map((install) => ({
      teamId: install.workspaceId,
      teamName: install.workspaceName,
      installedAt: install.installedAt,
    }));
  return {
    me,
    workspace,
    rollup,
    slack,
    // Removal is owner-only (the inverse of install); members can still open
    // Set defaults. Mirrors the server-side gate on the /integrations action.
    canManageSlack: role === "owner",
    docoPicker: await loadDocoPicker({
      integrationId: url.searchParams.get("integration"),
      userId: me.id,
      workspaceId: workspace.id,
    }),
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
  const { me, workspace, rollup, slack, canManageSlack, docoPicker } = loaderData;
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
              Everything wired up under {workspace.handle}, plus a rollup of each doco&apos;s
              connections.
            </p>
            <ScopeNavLinks scope="workspace" />
          </div>
        </PageHeader>

        <DocoPickerCard picker={docoPicker} />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Connected under {workspace.handle}
            </h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Workspace-level integrations</CardTitle>
                <CardDescription>
                  Connections that apply to every doco in this workspace.
                </CardDescription>
              </CardHeader>
              {slack.length > 0 ? (
                <CardContent className="p-0">
                  <ConnectionList>
                    {slack.map((team) => (
                      <ConnectionRow
                        key={team.teamId}
                        title={team.teamName}
                        detail={`Slack · installed ${formatDate(team.installedAt)}`}
                        action={{
                          label: "Set defaults",
                          href: slackSetupHref(team.teamId),
                          icon: ArrowRight,
                        }}
                        secondaryAction={
                          canManageSlack ? (
                            <RemoveSlackButton teamId={team.teamId} teamName={team.teamName} />
                          ) : undefined
                        }
                      />
                    ))}
                  </ConnectionList>
                </CardContent>
              ) : (
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    No workspace-wide integrations are configured yet. Connect Slack from the
                    catalog to bind a team to {workspace.handle}; its channel defaults are managed
                    here.
                  </p>
                </CardContent>
              )}
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Docos in this workspace</CardTitle>
                <CardDescription>
                  Each doco manages its own connections. Open one to drill in.
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
                    No docos in this workspace have integrations configured yet.
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

function slackSetupHref(teamId: string): string {
  return `/integrations/slack/setup?${new URLSearchParams({ team_id: teamId }).toString()}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
