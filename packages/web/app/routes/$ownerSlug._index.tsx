import { Link } from "react-router";
import { resolveOwnerSlug, getPrincipalById } from "@doco/db";
import { canAccessDoco } from "~/lib/doco-access.server";
import { listDocoStats } from "~/lib/doco-stats.server";
import { listAllDocos, loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { timeAgo } from "~/lib/time-ago";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

interface UserView {
  kind: "principal";
  id: string;
  username: string;
  display_name: string;
  email?: string;
}
interface OrgView {
  kind: "organization";
  id: string;
  slug: string;
  display_name: string;
  description?: string;
  members: { principal_id: string; role: string; username?: string }[];
}

async function findOwnerBySlug(slug: string): Promise<UserView | OrgView | null> {
  const resolved = await resolveOwnerSlug(slug);
  if (!resolved) return null;
  if (resolved.kind === "principal") {
    const p = resolved.principal;
    const fm = JSON.parse(p.raw_yaml) as Record<string, unknown>;
    const email =
      p.email ?? (fm.github_identity as { email?: string } | undefined)?.email ?? null;
    const out: UserView = {
      kind: "principal",
      id: p.id,
      username: p.username,
      display_name: p.display_name ?? slug,
    };
    if (typeof email === "string") out.email = email;
    return out;
  }
  // organization
  const o = resolved.org;
  const fm = JSON.parse(o.raw_yaml) as Record<string, unknown>;
  const members = ((fm.members as { principal_id: string; role: string }[] | undefined) ?? []).map(
    (m) => ({ ...m }),
  );
  // Resolve member usernames from Postgres.
  for (const m of members) {
    const p = await getPrincipalById(m.principal_id);
    if (p) (m as { username?: string }).username = p.username;
  }
  const out: OrgView = {
    kind: "organization",
    id: o.id,
    slug: o.slug,
    display_name: (fm.display_name as string) ?? o.name,
    members,
  };
  if (typeof fm.description === "string") out.description = fm.description;
  return out;
}

export async function loader({ params, request }: { params: { ownerSlug: string }; request: Request }) {
  const owner = await findOwnerBySlug(params.ownerSlug);
  if (!owner) throw new Response(`Owner "${params.ownerSlug}" not found.`, { status: 404 });
  const me = await getCurrentPrincipal(request);
  const allDocos = await listAllDocos();
  const ownDocos = allDocos.filter((e) => e.ownerSlug === params.ownerSlug);
  const visibility = await Promise.all(
    ownDocos.map((d) =>
      canAccessDoco({ ownerId: d.ownerId, visibility: d.visibility }, me?.id ?? null),
    ),
  );
  const docos = ownDocos.filter((_, i) => visibility[i]);
  const docoStats = await listDocoStats(docos.map((d) => d.docoId));
  const docosWithStats = docos.map((d) => ({
    ...d,
    stats: docoStats.get(d.docoId) ?? { nodes: 0, edges: 0, lastUpdatedAt: null },
  }));
  return {
    owner,
    docos: docosWithStats,
    host: await loadHostConfig(),
    me,
  };
}

export function meta({ params }: { params: { ownerSlug: string } }) {
  return [{ title: `${params.ownerSlug} · Doco` }];
}

export default function OwnerProfile({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { owner, docos, host, me } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-baseline gap-2">
              <Badge variant={owner.kind === "organization" ? "accent" : "default"}>
                {owner.kind}
              </Badge>
              <CardTitle className="text-xl">{owner.display_name}</CardTitle>
              <span className="text-xs text-muted-foreground">
                /{owner.kind === "principal" ? owner.username : owner.slug}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {owner.kind === "principal" ? (
              <div className="text-xs text-muted-foreground">
                {owner.email ? `${owner.email}` : "(no email)"} · ID:{" "}
                <span className="font-mono">{owner.id}</span>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {owner.description ? <p>{owner.description}</p> : null}
                <p className="mt-1 font-mono">{owner.id}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>docos</CardTitle>
          </CardHeader>
          <CardContent>
            {docos.length === 0 ? (
              <p className="text-xs text-muted-foreground">No docos yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>slug</TableHead>
                    <TableHead className="text-right">nodes</TableHead>
                    <TableHead className="text-right">edges</TableHead>
                    <TableHead className="text-right">last updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docos.map((e) => (
                    <TableRow key={e.docoId}>
                      <TableCell>
                        <Link to={`/${e.ownerSlug}/${e.docoSlug}`} className="text-primary hover:underline">
                          {e.ownerSlug}/{e.docoSlug}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-mono">{e.stats.nodes}</TableCell>
                      <TableCell className="text-right font-mono">{e.stats.edges}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {timeAgo(e.stats.lastUpdatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {owner.kind === "organization" ? (
          <Card>
            <CardHeader>
              <CardTitle>Members ({owner.members.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {owner.members.map((m) => (
                  <li key={m.principal_id} className="flex items-baseline gap-2">
                    <Badge>{m.role}</Badge>
                    {m.username ? (
                      <Link to={`/${m.username}`} className="text-primary hover:underline">
                        {m.username}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">{m.principal_id}</span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </main>
    </div>
  );
}
