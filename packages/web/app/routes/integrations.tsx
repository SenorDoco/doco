// /integrations — account-wide integrations page.
//
// Two panes:
//   Left  — a rollup of every workspace the user can reach and the connections
//           under it, shown as small entries: each Doco's GitHub repos and any
//           Slack team bound to the workspace. Drill into a workspace to manage
//           them (Slack is workspace-scoped, like GitHub is Doco-scoped). Slack
//           teams not bound to any workspace fall into a small "not linked"
//           list with a Remove control, since they have no workspace to manage
//           them from.
//   Right — full catalog of available integrations. Cross-scope clicks
//           land on the relevant picker so the user can pick an workspace or
//           Doco to install into.
import { getWorkspaceRole } from "@doco/db";
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import {
  AvailableIntegrations,
  ConnectionList,
  ConnectionRow,
  RemoveSlackButton,
  ScopePickerBanner,
} from "~/components/integrations-shell";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  type AccountIntegrationsRollup,
  loadAccountIntegrationsRollup,
} from "~/lib/integrations-summary.server";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session.server";
import { listSlackInstallations, removeSlackInstallation } from "~/lib/slack.server";

interface IntegrationsPageData {
  me: CurrentPrincipal;
  notice: string | null;
  slackConfirmation: SlackConfirmation | null;
  rollup: AccountIntegrationsRollup;
  pickingIntegrationId: string | null;
}

interface SlackConfirmation {
  workspaceName: string;
}

export async function loader({ request }: { request: Request }): Promise<IntegrationsPageData> {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }

  const rollup = await loadAccountIntegrationsRollup({ userId: me.id });

  return {
    me,
    slackConfirmation: readSlackConfirmation(url),
    notice: readNotice(url),
    rollup,
    pickingIntegrationId: url.searchParams.get("integration"),
  };
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }

  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "remove_slack") {
    return Response.json({ error: "unknown_intent" }, { status: 400 });
  }
  const workspaceId = String(form.get("workspace_id") ?? "").trim();
  if (!workspaceId) {
    return Response.json({ error: "missing_slack_workspace" }, { status: 400 });
  }

  const installation = (await listSlackInstallations()).find(
    (item) => item.workspaceId === workspaceId,
  );
  // Already gone — land back on the page either way (the click is idempotent).
  if (!installation) {
    throw redirect("/integrations?slack_removed=1");
  }

  // Severing a Slack team is the inverse of installing it, which only an OWNER
  // of the bound Doco workspace can do — so require that same ownership. An
  // unbound (legacy/orphan) team grants no access, so any signed-in user may
  // clear it.
  if (installation.docoWorkspaceId) {
    const role = await getWorkspaceRole(installation.docoWorkspaceId, me.id);
    if (role !== "owner") {
      return Response.json({ error: "owner_required" }, { status: 403 });
    }
  }

  await removeSlackInstallation(workspaceId);
  throw redirect(
    `/integrations?slack_removed=${encodeURIComponent(installation.workspaceName || workspaceId)}`,
  );
}

export function meta() {
  return [{ title: "App integrations · Doco" }];
}

export default function IntegrationsPage({ loaderData }: { loaderData: IntegrationsPageData }) {
  const { me, notice, slackConfirmation, rollup, pickingIntegrationId } = loaderData;

  // Slack teams bound to no workspace have nowhere to nest in the per-workspace
  // rollup, so they get a small "not linked" list of their own (Remove only).
  const unlinkedSlack = rollup.slack.filter((team) => !team.docoWorkspaceId);

  if (slackConfirmation) {
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <SiteHeader me={me} />
        <SingleColumnPageMain className="space-y-8 py-8">
          <Breadcrumb items={hostBreadcrumb({ pageLabel: "App integrations" })} />
          <section className="max-w-2xl space-y-5">
            <CheckCircle2 className="h-8 w-8 text-primary" aria-hidden="true" />
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold">Señor Doco is ready in Slack</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                You&apos;re done here. Default permissions are saved for{" "}
                {slackConfirmation.workspaceName}. Open Slack and say hello to Señor Doco from
                anywhere.
              </p>
            </div>
            <a
              href="/integrations"
              className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to integrations
            </a>
          </section>
        </SingleColumnPageMain>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader me={me} />
      <SingleColumnPageMain className="space-y-6 py-6">
        <PageHeader
          breadcrumb={hostBreadcrumb({ pageLabel: "App integrations" })}
          title="App integrations"
        >
          <p className="text-sm text-muted-foreground">
            A rollup of every workspace you can reach and the connections under it — each
            doco&apos;s GitHub repos and any Slack team. Open a workspace to manage them.
          </p>
        </PageHeader>

        {notice ? (
          <div className="rounded-md border border-border bg-background p-3 text-sm text-foreground">
            {notice}
          </div>
        ) : null}

        <ScopePickerBanner integrationId={pickingIntegrationId} pageScope="account" />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Connected on your account
            </h2>

            <Card id="pick-workspace">
              <CardHeader>
                <CardTitle className="text-base">App integrations across your workspaces</CardTitle>
                <CardDescription>
                  Each workspace rolls up its docos&apos; GitHub repos and any Slack team bound to
                  it; open one to manage.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <span id="pick-doco" />
                {rollup.workspaces.length > 0 ? (
                  <ConnectionList>
                    {rollup.workspaces.map((o) => {
                      const docosWithIntegrations = rollup.docos.filter(
                        (d) => d.workspaceHandle === o.handle,
                      );
                      const slackTeams = rollup.slack.filter(
                        (team) => team.docoWorkspaceId === o.workspaceId,
                      );
                      const detailParts: string[] = [];
                      if (docosWithIntegrations.length > 0) {
                        detailParts.push(
                          `${docosWithIntegrations.length} doco${
                            docosWithIntegrations.length === 1 ? "" : "s"
                          } with connections`,
                        );
                      }
                      if (slackTeams.length > 0) {
                        detailParts.push(
                          `${slackTeams.length} Slack team${slackTeams.length === 1 ? "" : "s"}`,
                        );
                      }
                      return (
                        <ConnectionRow
                          key={o.workspaceId}
                          title={o.handle}
                          titleHref={`/workspaces/${o.handle}/integrations`}
                          detail={
                            detailParts.length > 0 ? detailParts.join(" · ") : "No connections yet"
                          }
                          action={{
                            label: "Manage",
                            href: `/workspaces/${o.handle}/integrations`,
                            icon: ArrowRight,
                          }}
                        >
                          {docosWithIntegrations.length > 0 || slackTeams.length > 0 ? (
                            <ul className="mt-2 space-y-1 pl-3 text-xs">
                              {docosWithIntegrations.map((d) => (
                                <li key={d.docoId} className="flex items-center gap-2">
                                  <span className="text-muted-foreground">↳</span>
                                  <Link
                                    to={`/${d.handle}/integrations`}
                                    className="font-mono hover:text-primary"
                                  >
                                    {d.handle}
                                  </Link>
                                  <span className="text-muted-foreground">
                                    {d.githubRepoCount} GitHub repo
                                    {d.githubRepoCount === 1 ? "" : "s"}
                                  </span>
                                </li>
                              ))}
                              {slackTeams.map((team) => (
                                <li key={team.workspaceId} className="flex items-center gap-2">
                                  <span className="text-muted-foreground">↳</span>
                                  <Link
                                    to={`/workspaces/${o.handle}/integrations`}
                                    className="font-mono hover:text-primary"
                                  >
                                    {team.workspaceName}
                                  </Link>
                                  <span className="text-muted-foreground">Slack</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </ConnectionRow>
                      );
                    })}
                  </ConnectionList>
                ) : (
                  <p className="px-4 py-3 text-sm text-muted-foreground">
                    You aren&apos;t a member of any workspaces yet.
                  </p>
                )}
              </CardContent>
            </Card>

            {unlinkedSlack.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Slack teams not linked to a workspace</CardTitle>
                  <CardDescription>
                    These installs aren&apos;t bound to any workspace, so Señor Doco can&apos;t
                    reach a doco from them. Remove them here, or reconnect from Slack to bind one.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <ConnectionList>
                    {unlinkedSlack.map((team) => (
                      <ConnectionRow
                        key={team.workspaceId}
                        title={team.workspaceName}
                        detail="Not linked to any workspace"
                        secondaryAction={
                          <RemoveSlackButton
                            teamId={team.workspaceId}
                            teamName={team.workspaceName}
                          />
                        }
                      />
                    ))}
                  </ConnectionList>
                </CardContent>
              </Card>
            ) : null}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Available integrations</h2>
            <AvailableIntegrations pageScope="account" />
          </section>
        </div>
      </SingleColumnPageMain>
    </div>
  );
}

function readSlackConfirmation(url: URL): SlackConfirmation | null {
  const connected = url.searchParams.get("slack_connected");
  if (!connected) return null;
  return { workspaceName: connected };
}

function readNotice(url: URL): string | null {
  const installed = url.searchParams.get("slack_installed");
  if (installed) {
    return `Slack workspace connected: ${installed}. Choose default permissions next.`;
  }
  const removed = url.searchParams.get("slack_removed");
  if (removed) {
    return removed === "1" ? "Slack workspace removed." : `Slack workspace removed: ${removed}.`;
  }
  if (url.searchParams.get("slack_not_installed")) {
    return "Install Señor Doco in Slack before setting default permissions.";
  }
  if (url.searchParams.get("slack_unavailable")) {
    return "Slack is not available yet for this doco deployment.";
  }
  if (url.searchParams.get("slack_error")) {
    return "Slack installation did not complete. Try connecting Slack again.";
  }
  return null;
}
