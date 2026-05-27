import { ArrowLeft, CheckCircle2, ExternalLink, MessageSquare, Settings } from "lucide-react";
import { redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session.server";
import {
  type SlackInstallationSummary,
  getSlackConfig,
  listSlackInstallations,
} from "~/lib/slack.server";

interface IntegrationsPageData {
  me: CurrentPrincipal;
  notice: string | null;
  slackConfirmation: SlackConfirmation | null;
  slackInstallHref: string | null;
  slackInstallations: SlackInstallationSummary[];
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

  return {
    me,
    slackConfirmation: readSlackConfirmation(url),
    notice: readNotice(url),
    slackInstallHref: getSlackConfig().configured ? "/integrations/slack/install" : null,
    slackInstallations: await listSlackInstallations(),
  };
}

export function meta() {
  return [{ title: "Integrations · Doco" }];
}

export default function IntegrationsPage({ loaderData }: { loaderData: IntegrationsPageData }) {
  const { me, notice, slackConfirmation, slackInstallHref, slackInstallations } = loaderData;

  if (slackConfirmation) {
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <SiteHeader mode="host" me={me} />
        <SingleColumnPageMain className="space-y-8 py-8">
          <Breadcrumb items={hostBreadcrumb({ pageLabel: "Integrations" })} />
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
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="space-y-6 py-8">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Integrations" })} />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            Connect Señor Doco to Slack, then set its default permissions.
          </p>
        </header>

        {notice ? (
          <div className="rounded-md border border-border bg-background p-3 text-sm text-foreground">
            {notice}
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-primary" aria-hidden="true" />
                  Slack
                </CardTitle>
                <CardDescription>
                  Install Señor Doco into a Slack workspace. Doco will ask for its default
                  permissions immediately after Slack approves the app.
                </CardDescription>
              </div>
              {slackInstallHref ? (
                <a
                  href={slackInstallHref}
                  className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                >
                  Connect Slack
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  className="neu-button inline-flex cursor-not-allowed items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground opacity-50"
                >
                  Slack unavailable
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {slackInstallHref ? (
              slackInstallations.length > 0 ? (
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold">Connected Slack workspaces</h2>
                  <div className="divide-y divide-border rounded-md border border-border">
                    {slackInstallations.map((installation) => (
                      <SlackInstallationRow
                        key={installation.workspaceId}
                        installation={installation}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  No Slack workspace has installed Señor Doco yet. Start with Connect Slack; after
                  Slack approves the app, the next screen will ask which default Doco permissions
                  Señor Doco should receive.
                </p>
              )
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Slack is not ready for this Doco deployment yet. Once the Slack app is configured,
                this screen will show the Connect Slack button.
              </p>
            )}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}

function SlackInstallationRow({ installation }: { installation: SlackInstallationSummary }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div>
        <span className="block text-sm font-semibold text-foreground">
          {installation.workspaceName}
        </span>
        <span className="block text-xs text-muted-foreground">
          Installed {formatDate(installation.installedAt)}
        </span>
      </div>
      <a
        href={slackSetupHref(installation)}
        className="neu-button inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground hover:text-primary"
      >
        <Settings className="h-4 w-4" aria-hidden="true" />
        Set defaults
      </a>
    </div>
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
