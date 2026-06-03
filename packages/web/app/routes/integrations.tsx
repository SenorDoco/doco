// /integrations — account-wide integrations page.
//
// Two panes:
//   Left  — everything wired up: account-level Slack workspaces, plus a
//           rollup of every workspace and Doco the user can read that already
//           has integrations. Drill-down links jump to that scope's page.
//   Right — full catalog of available integrations. Cross-scope clicks
//           land on the relevant picker so the user can pick an workspace or
//           Doco to install into.
import { getWorkspaceRole } from "@doco/db";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { Form, Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import {
  AvailableIntegrations,
  CONNECTION_ACTION_DESTRUCTIVE,
  ConnectionList,
  ConnectionRow,
  ScopePickerBanner,
} from "~/components/integrations-shell";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadScopeOptions } from "~/lib/api-keys.server";
import {
  type AccountIntegrationsRollup,
  loadAccountIntegrationsRollup,
} from "~/lib/integrations-summary.server";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session.server";
import {
  type SlackInstallationSummary,
  getSlackConfig,
  listSlackInstallations,
  removeSlackInstallation,
} from "~/lib/slack.server";

interface IntegrationsPageData {
  me: CurrentPrincipal;
  notice: string | null;
  slackConfirmation: SlackConfirmation | null;
  slackInstallHref: string | null;
  slackInstallations: SlackInstallationSummary[];
  /** Slack team ids this user may remove (owner of the bound workspace, or the
   * team is unbound). The Remove control renders only for these. */
  removableTeamIds: string[];
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

  const slackInstallations = await listSlackInstallations();
  const rollup = await loadAccountIntegrationsRollup({ userId: me.id });

  return {
    me,
    slackConfirmation: readSlackConfirmation(url),
    notice: readNotice(url),
    slackInstallHref: getSlackConfig().configured ? "/integrations/slack/install" : null,
    slackInstallations,
    removableTeamIds: await removableSlackTeamIds(me.id, slackInstallations),
    rollup: { ...rollup, slack: slackInstallations },
    pickingIntegrationId: url.searchParams.get("integration"),
  };
}

/**
 * Which of these Slack teams the user may remove. Removal is the inverse of
 * install (owner-only on the bound Doco workspace), so it takes ownership of
 * that bound workspace. An unbound team grants no Doco access, so it's an
 * orphan any signed-in user may clear.
 */
async function removableSlackTeamIds(
  userId: string,
  installations: SlackInstallationSummary[],
): Promise<string[]> {
  if (installations.length === 0) return [];
  const ownedWorkspaceIds = new Set(
    (await loadScopeOptions(userId))
      .filter((option) => option.level === "workspace" && option.myRole === "owner")
      .map((option) => option.id),
  );
  return installations
    .filter((item) => (item.docoWorkspaceId ? ownedWorkspaceIds.has(item.docoWorkspaceId) : true))
    .map((item) => item.workspaceId);
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
  const {
    me,
    notice,
    slackConfirmation,
    slackInstallHref,
    slackInstallations,
    removableTeamIds,
    rollup,
    pickingIntegrationId,
  } = loaderData;

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
            Everything connected to your account, plus a rollup of every workspace and Doco you can
            reach.
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

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <MessageSquare className="h-5 w-5 text-primary" aria-hidden="true" />
                      Slack workspaces
                    </CardTitle>
                    <CardDescription>
                      Each Slack team is connected to one Doco workspace. After install, channel
                      defaults wire individual channels to specific Docos within that workspace.
                    </CardDescription>
                  </div>
                  {slackInstallHref ? (
                    <a
                      href={slackInstallHref}
                      className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                    >
                      Connect Slack
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="neu-button inline-flex cursor-not-allowed items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground opacity-50"
                    >
                      Slack unavailable
                    </button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {slackInstallHref ? (
                  slackInstallations.length > 0 ? (
                    <ConnectionList>
                      {slackInstallations.map((installation) => (
                        <ConnectionRow
                          key={installation.workspaceId}
                          title={installation.workspaceName}
                          detail={`Installed ${formatDate(installation.installedAt)}`}
                          action={{
                            label: "Set defaults",
                            href: slackSetupHref(installation),
                            icon: ArrowRight,
                          }}
                          secondaryAction={
                            removableTeamIds.includes(installation.workspaceId) ? (
                              <RemoveSlackButton installation={installation} />
                            ) : undefined
                          }
                        />
                      ))}
                    </ConnectionList>
                  ) : (
                    <p className="px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                      No Slack workspace has installed Señor Doco yet. After Slack approves the app,
                      the next screen asks which default Doco permissions Señor Doco should receive.
                    </p>
                  )
                ) : (
                  <p className="px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                    Slack is not ready for this Doco deployment yet. Once the Slack app is
                    configured, this screen will show the Connect Slack button.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card id="pick-workspace">
              <CardHeader>
                <CardTitle className="text-base">App integrations across your workspaces</CardTitle>
                <CardDescription>
                  Each workspace rolls up its Docos&apos; connections; open one to manage.
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
                      return (
                        <ConnectionRow
                          key={o.workspaceId}
                          title={o.handle}
                          titleHref={`/workspaces/${o.handle}/integrations`}
                          detail={`${docosWithIntegrations.length} Doco${
                            docosWithIntegrations.length === 1 ? "" : "s"
                          } with connections`}
                          action={{
                            label: "Manage",
                            href: `/workspaces/${o.handle}/integrations`,
                            icon: ArrowRight,
                          }}
                        >
                          {docosWithIntegrations.length > 0 ? (
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

/**
 * The destructive "Remove" control for a Slack install row, rendered as the
 * row's secondaryAction next to "Set defaults". A confirm() guards the
 * irreversible delete before the form posts the remove_slack intent.
 */
function RemoveSlackButton({ installation }: { installation: SlackInstallationSummary }) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="remove_slack" />
      <input type="hidden" name="workspace_id" value={installation.workspaceId} />
      <button
        type="submit"
        onClick={(event) => {
          if (
            !confirm(
              `Remove Señor Doco from ${installation.workspaceName}? This deletes its channel defaults and personal links, and can't be undone.`,
            )
          ) {
            event.preventDefault();
          }
        }}
        className={CONNECTION_ACTION_DESTRUCTIVE}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        Remove
      </button>
    </Form>
  );
}

function slackSetupHref(installation: SlackInstallationSummary): string {
  const params = new URLSearchParams({ team_id: installation.workspaceId });
  return `/integrations/slack/setup?${params.toString()}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
    return "Slack is not available yet for this Doco deployment.";
  }
  if (url.searchParams.get("slack_error")) {
    return "Slack installation did not complete. Try connecting Slack again.";
  }
  return null;
}
