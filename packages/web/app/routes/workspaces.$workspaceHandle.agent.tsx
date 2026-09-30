// /workspaces/:workspaceHandle/agent — step 2 of Get started for one
// workspace: the instructions to give an agent, ending with the line that
// connects the project to this workspace. Creating a workspace lands here,
// and each workspace's Invite agent button opens it.

import { getPublicBaseUrl } from "@doco/shared";
import { Link, redirect } from "react-router";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { workspaceBreadcrumb } from "~/components/breadcrumb";
import { PageHeader } from "~/components/page-header";
import { SiteHeader } from "~/components/site-header";
import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import { getCurrentPrincipal } from "~/lib/session.server";
import { loadWorkspaceForRead } from "~/lib/workspace-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  }
  const { workspace } = await loadWorkspaceForRead(params.workspaceHandle, me.id);
  return {
    me,
    workspace: { handle: workspace.handle },
    instructions: agentInstructionsForWorkspace(getPublicBaseUrl(request), workspace.handle),
  };
}

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Connect your agent · ${data?.workspace.handle ?? "Workspace"} · Doco` }];
}

export default function WorkspaceAgentPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, workspace, instructions } = loaderData;
  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <PageHeader
          breadcrumb={workspaceBreadcrumb({
            workspaceSlug: workspace.handle,
            pageLabel: "Connect your agent",
          })}
          title={`Connect your agent to ${workspace.handle}`}
          actions={
            <Link
              to={`/workspaces/${workspace.handle}`}
              className="neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              Go to workspace
            </Link>
          }
        />
        <AgentInstructionsBlock
          title="Give your agent these instructions. The last line connects the project to this workspace."
          instructions={instructions}
        />
      </main>
    </div>
  );
}
