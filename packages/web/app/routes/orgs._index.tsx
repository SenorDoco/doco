// /orgs — host-level orgs listing. Top-bar link from the site header
// (replaces the "+ Org" shortcut). Shows the orgs the signed-in
// principal belongs to + a "create a new org" link.

import { Link, redirect } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { listMyOrgs } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return redirect(`/sign-in?next=${encodeURIComponent("/orgs")}`);
  }
  const orgs = await listMyOrgs(me.id);
  return { me, orgs };
}

export function meta() {
  return [{ title: "Orgs · Doco" }];
}

interface OrgsLoaderData {
  me: { id: string; username: string; type: "person" | "agent"; isHuman: boolean; email?: string };
  orgs: {
    id: string;
    slug: string;
    display_name: string;
    description?: string;
    member_count?: number;
  }[];
}

export default function OrgsIndexPage({
  loaderData,
}: {
  loaderData: OrgsLoaderData;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Orgs</h1>
            <p className="text-sm text-muted-foreground">
              Organizations you belong to. To manage org users, open the{" "}
              <Link to="/users" className="underline">
                Users
              </Link>{" "}
              page.
            </p>
          </div>
          <Link
            to="/new-org"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            + Org
          </Link>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Your orgs</CardTitle>
          </CardHeader>
          <CardContent>
            {loaderData.orgs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You aren't a member of any org yet.{" "}
                <Link to="/new-org" className="underline">
                  Create one
                </Link>
                .
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {loaderData.orgs.map((o) => (
                  <li key={o.id} className="py-3">
                    <Link to={`/${o.slug}`} className="font-medium hover:underline">
                      {o.slug}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {o.display_name}
                      {typeof o.member_count === "number"
                        ? ` · ${o.member_count} member${o.member_count === 1 ? "" : "s"}`
                        : ""}
                    </div>
                    {o.description ? (
                      <div className="mt-1 text-sm text-muted-foreground">{o.description}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
