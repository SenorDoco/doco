import { Link } from "react-router";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { rootDir, getMode } from "~/lib/db";
import { listAllEvalos, loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
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

function findOwnerBySlug(slug: string): UserView | OrgView | null {
  const principalsDir = join(rootDir(), "principals");
  if (existsSync(principalsDir)) {
    for (const name of readdirSync(principalsDir)) {
      if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
      const e = parseYaml(readFileSync(join(principalsDir, name), "utf8")) as Record<string, unknown>;
      if (e.username === slug) {
        const email = (e.github_identity as { email?: string } | undefined)?.email;
        return {
          kind: "principal",
          id: e.id as string,
          username: e.username as string,
          display_name: (e.display_name as string) ?? slug,
          ...(typeof email === "string" ? { email } : {}),
        };
      }
    }
  }
  const orgsDir = join(rootDir(), "organizations");
  if (existsSync(orgsDir)) {
    for (const name of readdirSync(orgsDir)) {
      if (!name.startsWith("organization_") || !name.endsWith(".yaml")) continue;
      const e = parseYaml(readFileSync(join(orgsDir, name), "utf8")) as Record<string, unknown>;
      if (e.slug === slug) {
        const members = ((e.members as { principal_id: string; role: string }[] | undefined) ?? []).map(
          (m) => ({ ...m }),
        );
        // Resolve member usernames.
        if (existsSync(principalsDir)) {
          for (const pname of readdirSync(principalsDir)) {
            if (!pname.startsWith("principal_") || !pname.endsWith(".yaml")) continue;
            const p = parseYaml(readFileSync(join(principalsDir, pname), "utf8")) as Record<string, unknown>;
            for (const m of members) {
              if (m.principal_id === p.id) (m as { username?: string }).username = p.username as string;
            }
          }
        }
        return {
          kind: "organization",
          id: e.id as string,
          slug: e.slug as string,
          display_name: (e.display_name as string) ?? slug,
          ...(e.description !== undefined ? { description: e.description as string } : {}),
          members,
        };
      }
    }
  }
  return null;
}

export function loader({ params, request }: { params: { ownerSlug: string }; request: Request }) {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  const owner = findOwnerBySlug(params.ownerSlug);
  if (!owner) throw new Response(`Owner "${params.ownerSlug}" not found.`, { status: 404 });
  const allEvalos = listAllEvalos();
  const evalos = allEvalos.filter((e) => e.ownerSlug === params.ownerSlug);
  return {
    owner,
    evalos,
    host: loadHostConfig(),
    me: getCurrentPrincipal(request),
  };
}

export function meta({ params }: { params: { ownerSlug: string } }) {
  return [{ title: `${params.ownerSlug} · Evalo` }];
}

export default function OwnerProfile({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { owner, evalos, host, me } = loaderData;
  return (
    <div>
      <SiteHeader context={host.name} mode="host" me={me} />
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
            <CardTitle>Evalos ({evalos.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {evalos.length === 0 ? (
              <p className="text-xs text-muted-foreground">No Evalos yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>slug</TableHead>
                    <TableHead>indexed?</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {evalos.map((e) => (
                    <TableRow key={e.evaloId}>
                      <TableCell>
                        <Link to={`/${e.ownerSlug}/${e.evaloSlug}`} className="text-primary hover:underline">
                          {e.ownerSlug}/{e.evaloSlug}
                        </Link>
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
