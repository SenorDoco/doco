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
            pageLabel: "Invite a collaborator",
          })}
        />
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">Invite a collaborator</h1>
            <p className="text-sm text-muted-foreground">
              Create a single-use invite link to share with a teammate. They open it, sign in with
              GitHub, and land in your Doco with the role you pick.
            </p>
          </div>
          <Link
            to="/collaborators"
            className="neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold"
          >
            View collaborators
          </Link>
        </header>
        <CollaboratorInviteCards invite={loaderData.invite} />
      </SingleColumnPageMain>
    </div>
  );
}
