// Onboarding step: hand the Doco off to an AI agent.
//
// Reached from the scope-setup flow's "Continue to Doco →" link after
// the project owner has decided which scopes to use. The page mints a
// fresh 7-day invite for the signed-in admin and renders the single
// collaboration prompt the project owner can hand to a human or agent.
// The invite URL itself owns the branching: signed-in humans accept,
// signed-out humans sign in, and agents discover /invite/<code>/agent.txt.
//
// The "Keep it simple" path on /new-doco skips scope setup, then routes
// through this handoff before the Doco home.

import type { EntityId } from "@doco/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { TokenStore } from "~/lib/tokens.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle } = await normalizeDocoParams(params);
  const { meta, me } = await loadDocoForAdmin(request, handle);

  const store = TokenStore.forDoco(rootDir());
  const invite = await store.issueInvite(
    meta.docoId as EntityId<"doco">,
    (me?.id ?? null) as EntityId<"principal"> | null,
    7,
  );
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const inviteUrl = `${origin}/invite/${invite.code}`;
  const docoUrl = `${origin}/${handle}/`;
  const recipeUrl = `${origin}/protocol/agent-oauth-recipe`;
  const deviceUrl = `${origin}/device`;

  return { handle, inviteUrl, docoUrl, recipeUrl, deviceUrl, me };
}

export function meta() {
  return [{ title: "Hand it to your AI agent · Doco" }];
}

export default function OnboardingAgent({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { handle, inviteUrl, docoUrl, recipeUrl, deviceUrl, me } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Invite collaborators</CardTitle>
            <CardDescription>
              Two prompts — one for a human collaborator (sign-in + Accept in a
              browser), one for an AI agent (OAuth via Device Flow or
              localhost-loopback; recipe at /protocol/agent-oauth-recipe).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <CollaborationInvitePrompt
              inviteUrl={inviteUrl}
              docoUrl={docoUrl}
              recipeUrl={recipeUrl}
              deviceUrl={deviceUrl}
              continueTo={`/${handle}`}
            />
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
