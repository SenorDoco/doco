import { Link, redirect } from "react-router";
import { canAccessDoco } from "~/lib/doco-access.server";
import { listAllDocos, listOrgs, listUsers, loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

/**
 * /dashboard — signed-in host dashboard. Lists all Docos, users, and
 * organizations registered on this host. The Doco wordmark + "what is Doco"
 * marketing copy lives on the home page (/) instead.
 */
export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const allDocos = await listAllDocos();
  const visibility = await Promise.all(
    allDocos.map((d) =>
      canAccessDoco({ ownerId: d.ownerId, visibility: d.visibility }, me.id),
    ),
  );
  const docos = allDocos.filter((_, i) => visibility[i]);
  return {
    host: await loadHostConfig(),
    me,
    users: await listUsers(),
    orgs: await listOrgs(),
    docos,
  };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Dashboard · Doco" }];
  return [{ title: `${data.host.name} · Doco` }];
}

export default function Dashboard({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { host, me, users, orgs, docos } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Docos ({docos.length})</CardTitle>
            <CardDescription>All Docos registered in this host. Click to open.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>slug</TableHead>
                  <TableHead>owner</TableHead>
                  <TableHead>id</TableHead>
                  <TableHead>indexed?</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docos.map((e) => (
                  <TableRow key={e.docoId}>
                    <TableCell>
                      <Link
                        to={`/${e.ownerSlug}/${e.docoSlug}`}
                        className="text-primary hover:underline"
                      >
                        {e.ownerSlug}/{e.docoSlug}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={e.ownerKind === "organization" ? "accent" : "default"}>
                        {e.ownerKind}
                      </Badge>{" "}
                      <span className="text-muted-foreground text-xs">{e.ownerSlug}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {e.docoId}
                    </TableCell>
                    <TableCell>
                      {e.hasIndex ? (
                        <Badge variant="success">indexed</Badge>
                      ) : (
                        <Badge variant="warning">no index</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Users ({users.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {users.map((u) => (
                  <li key={u.id} className="flex items-baseline gap-2">
                    <span className="font-semibold">{u.username}</span>
                    {u.email ? (
                      <span className="text-muted-foreground text-xs">{u.email}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Organizations ({orgs.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {orgs.map((o) => (
                  <li key={o.id} className="flex items-baseline gap-2">
                    <Badge variant="accent">{o.slug}</Badge>
                    <span className="text-muted-foreground text-xs">
                      {o.member_count} member(s)
                      {o.description ? ` · ${o.description}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
