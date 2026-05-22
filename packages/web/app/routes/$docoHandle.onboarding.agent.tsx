// Onboarding step: hand the Doco off to an AI agent.
//
// Mints a fresh 7-day invite for the signed-in admin and renders the
// single collaboration prompt the project owner can hand to a human
// or agent. The invite URL owns the branching: signed-in people
// accept, signed-out people sign in, and agents discover
// /invite/<code>/agent.txt.

import type { EntityId } from "@doco/shared";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { WizardStepper } from "~/components/wizard-stepper";
import { rootDir } from "~/lib/db.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { InviteStore } from "~/lib/invite-store.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle, me, meta, ownerSlug } = await loadDocoRouteForAdmin(request, params);

  const store = InviteStore.forDoco(rootDir());
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

  return { handle, ownerSlug, inviteUrl, docoUrl, recipeUrl, deviceUrl, me };
}

export function meta() {
  return [{ title: "Bootstrap and collaborate · Doco" }];
}

export default function OnboardingAgent({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { handle, ownerSlug, inviteUrl, docoUrl, recipeUrl, deviceUrl, me } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb
          items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Bootstrap and collaborate" })}
        />
        <WizardStepper current={3} />
        <Card>
          <CardHeader>
            <CardTitle>Bootstrap and collaborate</CardTitle>
            <CardDescription>
              Invite people, connect agents, and let each collaborator bootstrap from the Doco's
              primitives before they work.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="ml-5 list-disc space-y-2 text-sm">
              <li>Share the human invite with teammates who should join this Doco.</li>
              <li>Paste the agent prompt into an AI agent that should collaborate on the work.</li>
              <li>
                Agents use OAuth, then fetch the bootstrap manifest so they can read the relevant
                org and Doco primitives before writing neurons.
              </li>
            </ul>
            <CollaborationInvitePrompt
              inviteUrl={inviteUrl}
              docoUrl={docoUrl}
              recipeUrl={recipeUrl}
              deviceUrl={deviceUrl}
              continueTo={`/${handle}`}
              continueLabel="Open your Doco ->"
            />
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
