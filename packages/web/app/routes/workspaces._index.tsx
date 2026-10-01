// /workspaces — the signed-in home. One card per workspace the person
// reaches: the icons of its Docos, New Doco or source / Invite person /
// Invite agent, the latest thing that happened in it, and, while its steps
// aren't done, the way back to the step the person is on. Most recently
// active first. Someone in no project's workspace yet (only the personal one
// every person gets) is shown how to start one.

import { withClient } from "@doco/db";
import { Link, redirect } from "react-router";
import { hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { type WorkspaceSetup, WorkspaceSummaryCard } from "~/components/workspace-summary-card";
import { STEP_TITLES, pendingStep } from "~/lib/onboarding-steps";
import { loadUnfinishedOnboarding } from "~/lib/onboarding.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { loadWorkspaceSummaries } from "~/lib/workspace-summaries.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent("/workspaces")}`);
  }
  const { unfinished, workspaces } = await withClient(async (c) => ({
    unfinished: await loadUnfinishedOnboarding(c, me.id),
    workspaces: await loadWorkspaceSummaries(c, me.id),
  }));
  const setup: Record<string, WorkspaceSetup> = {};
  for (const [workspaceId, progress] of unfinished) {
    const step = pendingStep(progress);
    if (!step) continue;
    setup[workspaceId] = {
      title: STEP_TITLES[step],
      number: progress.steps.findIndex((s) => s.step === step) + 1,
      total: progress.steps.length,
    };
  }
  return { me, setup, workspaces };
}

export function meta() {
  return [{ title: "Workspaces · Doco" }];
}

export default function WorkspacesPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, setup, workspaces } = loaderData;
  // Every person gets a personal workspace named after them; it isn't a project's.
  const inAProject = workspaces.some((w) => w.handle.toLowerCase() !== me.username.toLowerCase());
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <PageHeader
        breadcrumb={hostBreadcrumb({ pageLabel: "Workspaces" })}
        title="Workspaces"
        actions={
          <Link
            to="/new-workspace"
            className="neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold"
          >
            New workspace
          </Link>
        }
      />

      {inAProject ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Start with a workspace</CardTitle>
            <CardDescription>
              A workspace holds one project's shared knowledge and context: its members, its
              constitution and its Docos. Create one and Doco walks you through connecting GitHub,
              your other sources and your agent. Invited to one? Open the invite to join it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              to="/new-workspace"
              className="neu-button inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
            >
              Create a workspace
            </Link>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3" aria-label="Your workspaces">
        {workspaces.map((workspace) => (
          <WorkspaceSummaryCard
            key={workspace.id}
            workspace={workspace}
            setup={setup[workspace.id]}
          />
        ))}
        {workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspaces yet.</p>
        ) : null}
      </section>
    </main>
  );
}
