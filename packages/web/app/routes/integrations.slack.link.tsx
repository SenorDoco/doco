/** @jsxImportSource react */
import { CheckCircle2 } from "lucide-react";
import { Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getCurrentPrincipal } from "~/lib/session.server";
import {
  getSlackConfig,
  upsertSlackUserLink,
  verifySlackPersonalAuthorizationState,
} from "~/lib/slack.server";

interface SlackLinkPageData {
  username: string;
  workspaceId: string;
  chatUserId: string;
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

  return {
    username: me.username,
    workspaceId: state.workspaceId,
    chatUserId: state.chatUserId,
  };
}

export function meta() {
  return [{ title: "Slack Authorized · Doco" }];
}

export default function SlackLinkPage({ loaderData }: { loaderData: SlackLinkPageData }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader />
      <SingleColumnPageMain className="space-y-6 py-8">
        <Breadcrumb
          items={[...hostBreadcrumb({ pageLabel: "Integrations" }), { label: "Slack" }]}
        />
        <Card className="max-w-2xl">
          <CardHeader>
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-primary" aria-hidden="true" />
              <CardTitle>Slack can use your Doco access</CardTitle>
            </div>
            <CardDescription>
              Señor Doco will use @{loaderData.username}'s Doco permissions for Slack requests from
              this Slack account, never more than that account already has in Doco.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Return to Slack and ask Señor Doco to try the action again.
            </p>
            <Link
              to="/integrations"
              className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Back to integrations
            </Link>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
