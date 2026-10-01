// /workspaces — the signed-in home. The Get started card until its three
// steps are done, then one card per workspace the person reaches: the icons
// of its Docos, New Doco or source / Invite person / Invite agent, and the
// latest thing that happened in it. Most recently active first.

import { withClient } from "@doco/db";
import { Link, redirect } from "react-router";
import { hostBreadcrumb } from "~/components/breadcrumb";
import { OnboardingCard } from "~/components/onboarding-card";
import { PageHeader } from "~/components/page-header";
import { WorkspaceSummaryCard } from "~/components/workspace-summary-card";
import { loadOnboardingProgress } from "~/lib/onboarding.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { loadWorkspaceSummaries } from "~/lib/workspace-summaries.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent("/workspaces")}`);
  }
  const { onboarding, workspaces } = await withClient(async (c) => ({
    onboarding: await loadOnboardingProgress(c, me.id),
    workspaces: await loadWorkspaceSummaries(c, me.id),
  }));
  return { onboarding, workspaces };
}

export function meta() {
  return [{ title: "Workspaces · Doco" }];
}

export default function WorkspacesPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { onboarding, workspaces } = loaderData;
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

      <OnboardingCard progress={onboarding} />

      <section className="space-y-3" aria-label="Your workspaces">
        {workspaces.map((workspace) => (
          <WorkspaceSummaryCard key={workspace.id} workspace={workspace} />
        ))}
        {workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspaces yet.</p>
        ) : null}
      </section>
    </main>
  );
}
