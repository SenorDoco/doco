/** @jsxImportSource react */
import { getWorkspaceById } from "@doco/db";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getCurrentPrincipal } from "~/lib/session.server";
import {
  getSlackBoundWorkspaceId,
  getSlackConfig,
  upsertSlackUserLink,
  verifySlackPersonalAuthorizationState,
} from "~/lib/slack.server";

interface SlackLinkPageData {
  username: string;
  workspaceId: string;
  chatUserId: string;
  /** Handle of the Doco workspace this Slack team is bound to, or null when
   * unbound (the team has no Doco access until an owner connects it). */
  boundWorkspaceHandle: string | null;
}

export async function loader({ request }: { request: Request }): Promise<SlackLinkPageData> {
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  const config = getSlackConfig();
  if (!config.signingSecret) {
    throw new Response("Slack is not configured.", { status: 500 });
  }

  let state: ReturnType<typeof verifySlackPersonalAuthorizationState>;
  try {
    state = verifySlackPersonalAuthorizationState(stateValue, config.signingSecret);
  } catch {
    throw new Response("This Slack authorization link is invalid or expired.", { status: 400 });
  }

  const me = await getCurrentPrincipal(request);
  if (!me) {
    throw redirect(`/auth/github?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }

  await upsertSlackUserLink({
    workspaceId: state.workspaceId,
    chatUserId: state.chatUserId,
    userId: me.id,
  });

  // The link's reach is capped to the Doco workspace this Slack team is bound
  // to (and is nothing until bound). Surface which one, so the confirmation
  // tells the truth instead of implying account-wide access.
  const boundWorkspaceId = await getSlackBoundWorkspaceId(state.workspaceId);
  const boundWorkspace = boundWorkspaceId ? await getWorkspaceById(boundWorkspaceId) : null;

  return {
    username: me.username,
    workspaceId: state.workspaceId,
    chatUserId: state.chatUserId,
    boundWorkspaceHandle: boundWorkspace?.handle ?? null,
  };
}

export function meta() {
  return [{ title: "Slack Authorized · Doco" }];
}

export default function SlackLinkPage({ loaderData }: { loaderData: SlackLinkPageData }) {
  const { username, boundWorkspaceHandle } = loaderData;
  const bound = boundWorkspaceHandle !== null;
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader />
      <SingleColumnPageMain className="space-y-6 py-8">
        <Breadcrumb
          items={[...hostBreadcrumb({ pageLabel: "App integrations" }), { label: "Slack" }]}
        />
        <Card className="max-w-2xl">
          <CardHeader>
            <div className="flex items-center gap-3">
              {bound ? (
                <CheckCircle2 className="h-6 w-6 text-primary" aria-hidden="true" />
              ) : (
                <ShieldAlert className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              )}
              <CardTitle>
                {bound
                  ? `Slack can use your access in the ${boundWorkspaceHandle} workspace`
                  : "Linked — but this Slack team has no Doco workspace yet"}
              </CardTitle>
            </div>
            <CardDescription>
              {bound ? (
                <>
                  Señor Doco will use @{username}'s access for Slack requests from this Slack team,
                  but <strong>only within the {boundWorkspaceHandle} workspace</strong> this team is
                  connected to — never any other workspace, and never more than the role you already
                  hold there.
                </>
              ) : (
                <>
                  This Slack team isn't connected to a Doco workspace, so Señor Doco can't use your
                  access yet. A workspace owner connects the team to exactly one Doco workspace on
                  the Slack setup page; after that, your access is limited to that one workspace.
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {bound
                ? "Return to Slack and ask Señor Doco to try the action again."
                : "Ask a workspace owner to connect this Slack team to a Doco workspace, then return to Slack and try again."}
            </p>
            <Link
              to="/integrations"
              className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Back to app integrations
            </Link>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
