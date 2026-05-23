import { Link } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { CollaboratorInviteCards } from "~/components/collaborator-invite-cards";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  type CollaboratorInvitePageData,
  handleCollaboratorInviteAction,
  loadCollaboratorInvitePageData,
} from "~/lib/collaborators.server";

export async function loader({ request }: { request: Request }) {
  return loadCollaboratorInvitePageData(request);
}

export async function action({ request }: { request: Request }) {
  return handleCollaboratorInviteAction(request);
}

export function meta() {
  return [{ title: "Invite collaborators · Doco" }];
}

export default function InviteCollaboratorsPage({
  loaderData,
}: {
  loaderData: CollaboratorInvitePageData;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <Breadcrumb
          items={hostBreadcrumb({
            section: { label: "Collaborators", to: "/collaborators" },
            pageLabel: "Invite collaborators",
          })}
        />
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">Invite collaborators</h1>
            <p className="text-sm text-muted-foreground">
              Create invite links for people, or copy an OAuth setup prompt for agents.
            </p>
          </div>
          <Link
            to="/collaborators"
            className="neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold"
          >
            View collaborators
          </Link>
        </header>
        <CollaboratorInviteCards host={loaderData.host} invite={loaderData.invite} />
      </SingleColumnPageMain>
    </div>
  );
}
