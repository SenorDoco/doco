import { Link, redirect } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { DocoPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadPostCreateDocoRouteForRead } from "~/lib/doco-access.server";
import { withCreatedDocoId } from "~/lib/post-create-doco-route";

/**
 * /:handle/welcome — post-create Doco concepts page.
 *
 * Reached after Step 1 creates the doco. Introduces the core Doco
 * concepts; the Continue button then drops the user straight on the
 * Doco home page (the prior `/onboarding/agent` "Bootstrap and
 * collaborate" step was removed since its affordances are reachable
 * from the doco page itself).
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
  return {
    me,
    handle: canonicalHandle,
    ownerSlug,
    createdDocoId,
  };
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
  // Continue lands the user on the doco home. The old
  // /:handle/onboarding/agent step ("Bootstrap and collaborate")
  // duplicated affordances now reachable from the doco page itself
  // (users link + API keys link), so it was removed from
  // the post-create flow. createdDocoId stays in the URL so the
  // Doco page can highlight the just-created Doco in any "recent"
  // surfaces.
  const docoHomePath = createdDocoId
    ? withCreatedDocoId(`/${handle}`, createdDocoId)
    : `/${handle}`;
  return (
    <div>
      <SiteHeader me={me} />
      <DocoPageMain className="py-8 space-y-4">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Welcome" })} />
        <Card>
          <CardHeader>
            <CardTitle>Key Doco concepts:</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="ml-5 list-disc space-y-2">
              <li>Doco helps keep people, agents, and work aligned</li>
              <li>
                Docos are made of nodes (any type of information) and edges (connections between
                nodes)
              </li>
              <li>
                Users, agents, and tools can query docos and add information (nodes) to them (if
                they have the permission)
              </li>
              <li>
                AI agents collaborating on a doco are always reminded of its policies — a list
                telling them how to behave
              </li>
              <li>An workspace can have multiple interconnected docos</li>
            </ul>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Link
            to={docoHomePath}
            className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
          >
            Open your doco -&gt;
          </Link>
        </div>
      </DocoPageMain>
    </div>
  );
}
