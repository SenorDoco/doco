// Onboarding page: bootstrap and collaborate.
//
// Mints a fresh 7-day human-invite URL for the signed-in admin and
// points them at /api-keys for the agent path. Per the
// users / API-keys split: human invites and agent tokens
// live on separate surfaces.

import type { EntityId } from "@doco/shared";
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { loadPostCreateDocoRouteForAdmin } from "~/lib/doco-access.server";
import { InviteStore } from "~/lib/invite-store.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle?: string; docoId?: string };
}) {
  const { handle, me, meta, ownerSlug } = await loadPostCreateDocoRouteForAdmin(request, params);

  const store = InviteStore.forDoco(rootDir());
  const invite = await store.issueInvite(
    meta.docoId as EntityId<"doco">,
    (me?.id ?? null) as EntityId<"principal"> | null,
    7,
  );
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const inviteUrl = `${origin}/invite/${invite.code}`;

  return { handle, ownerSlug, inviteUrl, me };
}

export function meta() {
  return [{ title: "Bootstrap and collaborate · Doco" }];
}

export default function OnboardingAgent({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { handle, ownerSlug, inviteUrl, me } = loaderData;
  return (
    <div>
      <SiteHeader me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb
          items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Bootstrap and collaborate" })}
        />
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
            <CardDescription>
              Share this single-use URL with someone who should join this Doco. They sign in with
              GitHub and click Accept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CollaborationInvitePrompt
              inviteUrl={inviteUrl}
              continueTo={`/${handle}`}
              continueLabel="Open your Doco →"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Add an AI agent</CardTitle>
            <CardDescription>
              Agents authenticate via OAuth or via a long-lived access token you mint for them.
              Tokens are scoped per workspace / doco and revocable any time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              to="/api-keys"
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 inline-flex rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              Go to API keys →
            </Link>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
