import { Link, redirect } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { WizardStepper } from "~/components/wizard-stepper";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";

/**
 * /:handle/welcome — Step 2 of 3 in the doco creation wizard.
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
  params: { docoId: string };
}) {
  const { me, canonicalHandle, ownerSlug } = await loadDocoRouteForRead(request, params);
  if (!me) throw redirect(`/sign-in?next=%2F${canonicalHandle}%2Fwelcome`);
  return { me, handle: canonicalHandle, ownerSlug };
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `Key Doco concepts · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function NewDocoStep4({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, handle, ownerSlug } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Welcome" })} />
        <WizardStepper current={2} />
        <Card>
          <CardHeader>
            <CardTitle>Key Doco concepts:</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="ml-5 list-disc space-y-2">
              <li>Doco helps keep people, agents, and work aligned</li>
              <li>Docos are made of nodes (concepts) and edges (connections between nodes)</li>
              <li>
                Collaborators can query docos and add information (nodes) to them (if they have the
                permission)
              </li>
              <li>
                AI agents collaborating on a doco are always reminded of its constitution: a list of
                articles telling them how to behave
              </li>
              <li>An organization can have multiple interconnected docos</li>
            </ul>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Link
            to={`/${handle}/onboarding/agent`}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Continue -&gt;
          </Link>
        </div>
      </SingleColumnPageMain>
    </div>
  );
}
