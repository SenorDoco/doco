import { Link, redirect } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadPostCreateDocoRouteForRead } from "~/lib/doco-access.server";
import { withCreatedDocoId } from "~/lib/post-create-doco-route";

/**
 * /:handle/welcome — post-create Doco concepts page.
 *
 * Reached after Step 1 creates the doco. Introduces the core Doco
 * concepts before sending the user to bootstrap and collaboration
 * setup.
 */

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle?: string; docoId?: string };
}) {
  const { me, canonicalHandle, ownerSlug, createdDocoId } = await loadPostCreateDocoRouteForRead(
    request,
    params,
  );
  if (!me) throw redirect(`/sign-in?next=%2F${canonicalHandle}%2Fwelcome`);
  return { me, handle: canonicalHandle, ownerSlug, createdDocoId };
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `Key Doco concepts · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function NewDocoStep4({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, handle, ownerSlug, createdDocoId } = loaderData;
  const onboardingPath = createdDocoId
    ? withCreatedDocoId(`/${handle}/onboarding/agent`, createdDocoId)
    : `/${handle}/onboarding/agent`;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Welcome" })} />
        <Card>
          <CardHeader>
            <CardTitle>Key Doco concepts:</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="ml-5 list-disc space-y-2">
              <li>Doco helps keep people, agents, and work aligned</li>
              <li>
                Docos are made of neurons (any type of information) and synapses (connections
                between neurons)
              </li>
              <li>
                Collaborators, agents, and tools can query docos and add information (neurons) to
                them (if they have the permission)
              </li>
              <li>
                AI agents collaborating on a doco are always reminded of its policies — a list
                telling them how to behave
              </li>
              <li>An organization can have multiple interconnected docos</li>
            </ul>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Link
            to={onboardingPath}
            className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
          >
            Continue -&gt;
          </Link>
        </div>
      </SingleColumnPageMain>
    </div>
  );
}
