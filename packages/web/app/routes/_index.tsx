import { Link } from "react-router";
import { listAllDocos, listOrgs, listUsers, loadHostConfig } from "~/lib/host";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { DocoMark } from "~/components/doco-mark";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

/**
 * Host home — anonymous landing OR signed-in dashboard. Per ADR-067 +
 * ADR-093 (single-doco mode is gone; only the host shape exists).
 */
export function loader({ request }: { request: Request }) {
  const host = loadHostConfig();
  const me = getCurrentPrincipal(request);
  if (!me) return { mode: "host-anonymous" as const, host };
  return {
    mode: "host" as const,
    host,
    me,
    users: listUsers(),
    orgs: listOrgs(),
    docos: listAllDocos(),
  };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Doco" }];
  return [{ title: `${data.host.name} · Doco` }];
}

export default function Home({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  if (loaderData.mode === "host") return <HostDashboard data={loaderData} />;
  return <HostLanding data={loaderData} />;
}

function HostLanding({
  data,
}: {
  data: Extract<Awaited<ReturnType<typeof loader>>, { mode: "host-anonymous" }>;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <Link
            to="/sign-in"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="flex max-w-2xl flex-col items-center gap-6 text-center">
          <DocoMark height={96} />
          <p className="max-w-lg text-sm text-muted-foreground">
            AI-native documentation of important ideas, decisions, and rules.
          </p>
          <h1 className="text-2xl font-bold tracking-tight pt-2">What are you here to do?</h1>

          <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            <Link
              to="/onboarding/join"
              className="group rounded-lg border border-border bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">Join an existing Doco</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Collaborate on a project that's already tracked here.
              </div>
            </Link>
            <Link
              to="/onboarding/create"
              className="group rounded-lg border border-border bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">Create a new Doco</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Start tracking alignment for a new project.
              </div>
            </Link>
          </div>

          <p className="max-w-md pt-6 text-xs text-muted-foreground">
            Are you an AI agent and don't know the answer? Ask whomever prompted you which way
            to go.
          </p>

          <p className="pt-2 text-[11px] text-muted-foreground">
            Hosted by <span className="font-semibold">{data.host.name}</span>
          </p>
        </div>
      </main>
    </div>
  );
}

function HostDashboard({
  data,
}: {
  data: Extract<Awaited<ReturnType<typeof loader>>, { mode: "host" }>;
}) {
  const { host, me, users, orgs, docos } = data;
  return (
    <div>
      <SiteHeader context={host.name} mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <section className="mb-4 flex flex-col items-center gap-3 py-8">
          <DocoMark height={80} />
          <p className="max-w-xl text-center text-xs text-muted-foreground">
            {host.name} — multi-tenant Doco host. Anyone can create a Doco; users can create
            organizations; Docos are owned by users or organizations.
          </p>
        </section>

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
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.docoId}</TableCell>
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
                    {u.email ? <span className="text-muted-foreground text-xs">{u.email}</span> : null}
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

// Suppress unused-import warning for CurrentPrincipal — used via `me` prop.
export type _ = CurrentPrincipal;
