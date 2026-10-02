// /workspaces/:workspaceHandle/onboarding — what the steps on a workspace's
// page post to, each a single click, and (GET) where they stand, which the
// page polls while it waits for the person's agent. Connecting GitHub isn't
// here: that step posts to the GitHub setup (/integrations/github), which asks
// which repositories to bring.
//
//   intent=source integration=<id>
//                              creates the source's Doco and goes to approve
//                              the copy (Slack, Notion), coming back here.
//   intent=finish-sources      finishes (or skips) the other sources.
//
// Every outcome redirects to the workspace page; a refusal rides along as
// ?onboarding=<reason> for the steps to explain.
import { getWorkspaceRole, withClient } from "@doco/db";
import { redirect } from "react-router";
import { KNOWLEDGE_SOURCE_INTEGRATIONS } from "~/lib/integrations-catalog";
import { KNOWLEDGE_SOURCE_CONNECTORS } from "~/lib/knowledge-sources.server";
import { pendingStep } from "~/lib/onboarding-steps";
import { finishSourcesStep, loadOnboardingProgress } from "~/lib/onboarding.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { ensureWorkspaceDoco, resolveWorkspaceByHandle } from "~/lib/workspace-helpers.server";

type RouteArgs = { request: Request; params: { workspaceHandle: string } };

async function signedInTo({ request, params }: RouteArgs) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`/workspaces/${params.workspaceHandle}`)}`);
  }
  const workspace = await resolveWorkspaceByHandle(params.workspaceHandle);
  if (!workspace) {
    throw new Response(`Workspace "${params.workspaceHandle}" not found.`, { status: 404 });
  }
  return { me, workspace };
}

export async function loader(args: RouteArgs) {
  const { me, workspace } = await signedInTo(args);
  const progress = await withClient((c) =>
    loadOnboardingProgress(c, { workspaceId: workspace.id, userId: me.id }),
  );
  return Response.json(
    { steps: progress?.steps ?? [], pending: progress ? pendingStep(progress) : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function action(args: RouteArgs): Promise<Response> {
  const { me, workspace } = await signedInTo(args);
  const { request } = args;
  const home = `/workspaces/${workspace.handle}`;
  const refused = (reason: string) => redirect(`${home}?onboarding=${reason}`);
  // Connecting sources makes Docos in the workspace and binds its apps: an
  // owner's call, as on each integration's own page.
  if ((await getWorkspaceRole(workspace.id, me.id)) !== "owner") return refused("not_owner");

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "source") {
    const integration = KNOWLEDGE_SOURCE_INTEGRATIONS.find(
      (i) => i.id === String(form.get("integration") ?? ""),
    );
    const connector = integration && KNOWLEDGE_SOURCE_CONNECTORS[integration.id];
    if (!integration || !connector?.configured()) return refused("source_unavailable");
    const doco = await ensureWorkspaceDoco({
      workspace,
      template: integration.template,
      handleSuffix: integration.template,
      userId: me.id,
    });
    // A copy of a team's Slack or Notion is never public.
    if (doco.visibility !== "private") return refused("source_public");
    const url = connector.authorizeUrl(request, {
      docoId: doco.id,
      workspaceId: workspace.id,
      userId: me.id,
      next: home,
    });
    return url ? redirect(url) : refused("source_unavailable");
  }

  if (intent === "finish-sources") {
    await withClient((c) => finishSourcesStep(c, { workspaceId: workspace.id, userId: me.id }));
    return redirect(home);
  }

  return refused("unknown");
}
