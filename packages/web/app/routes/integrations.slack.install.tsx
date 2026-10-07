import { redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageMain } from "~/components/page-main";
import { loadScopeOptions } from "~/lib/api-keys.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { buildSlackInstallUrl, getSlackConfig } from "~/lib/slack.server";

interface SlackInstallPageData {
  workspaces: { id: string; label: string }[];
}

// Install binds the Slack team to ONE Doco workspace up front, so a team is
// never installed-but-unbound. The owner picks the workspace here; it rides
// (signed) through the Slack OAuth round-trip and is set on the install row in
// the callback.
export async function loader({ request }: { request: Request }): Promise<SlackInstallPageData> {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  if (!getSlackConfig().configured) {
    throw redirect("/integrations?slack_unavailable=1");
  }

  // Only workspaces the user OWNS can be bound (they're delegating that
  // workspace's access to Slack).
  const owned = (await loadScopeOptions(me.id)).filter(
    (o) => o.level === "workspace" && o.myRole === "owner",
  );

  const chosen = url.searchParams.get("workspace_id")?.trim();
  if (chosen) {
    if (!owned.some((o) => o.id === chosen)) {
      throw redirect("/integrations/slack/install?error=not_owner");
    }
    const installUrl = buildSlackInstallUrl(request, me.id, chosen);
    if (!installUrl) throw redirect("/integrations?slack_unavailable=1");
    throw redirect(installUrl);
  }

  return { workspaces: owned.map((o) => ({ id: o.id, label: o.label })) };
}

export function meta() {
  return [{ title: "Add Slack · Doco" }];
}

export default function SlackInstallPage({ loaderData }: { loaderData: SlackInstallPageData }) {
  const { workspaces } = loaderData;
  return (
    <PageMain className="space-y-6 py-8">
      <Breadcrumb
        items={[...hostBreadcrumb({ pageLabel: "App integrations" }), { label: "Slack" }]}
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Choose a workspace for Slack</CardTitle>
          <CardDescription>
            A Slack team is connected to exactly one doco workspace. Señor Doco will only ever use
            that workspace's docos — and never more than the access each person already holds there.
            Pick the workspace this Slack team should use, then approve the install in Slack.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="slack-install-no-workspaces">
              You need to own a doco workspace before connecting Slack. Create one, then come back.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="slack-install-workspaces">
              {workspaces.map((w) => (
                <li key={w.id}>
                  <a
                    href={`/integrations/slack/install?workspace_id=${encodeURIComponent(w.id)}`}
                    data-testid={`slack-install-workspace-${w.id}`}
                    className="neu-button flex items-center justify-between rounded-md px-4 py-3 text-sm font-semibold"
                  >
                    <span>{w.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      Connect this workspace →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageMain>
  );
}
