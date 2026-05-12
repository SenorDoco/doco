import { Link } from "react-router";
import { getDocoSlug, getMode, openDb } from "~/lib/db";
import { listAllDocos, listOrgs, listUsers, loadHostConfig } from "~/lib/host";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { DocoMark } from "~/components/doco-mark";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

interface RecentItem {
  id: string;
  node_type: string;
  summary: string;
  created_at: string;
  slug: string | null;
  number: string | null;
  title: string | null;
}

export function loader({ request }: { request: Request }) {
  const mode = getMode();
  if (mode === "single-doco") {
    const db = openDb();
    try {
      const items = db
        .prepare(
          `SELECT id, node_type, summary, created_at, slug, number, title FROM (
             SELECT id, 'decision' AS node_type, summary, created_at, slug, number, NULL AS title FROM decision
             UNION ALL
             SELECT id, 'intent' AS node_type, summary, created_at, slug, NULL, title FROM intent
             UNION ALL
             SELECT id, 'idea' AS node_type, summary, created_at, NULL, NULL, NULL FROM idea
             UNION ALL
             SELECT id, 'rule' AS node_type, summary, created_at, slug, NULL, NULL FROM rule
             UNION ALL
             SELECT id, 'action' AS node_type, summary, created_at, NULL, NULL, NULL FROM action
             UNION ALL
             SELECT id, 'reasoning' AS node_type, summary, created_at, NULL, NULL, NULL FROM reasoning
             UNION ALL
             SELECT id, 'scope' AS node_type, summary, created_at, NULL, NULL, name AS title FROM scope
           )
           ORDER BY created_at DESC LIMIT 30`,
        )
        .all() as RecentItem[];
      return { mode: "single-doco" as const, items, docoSlug: getDocoSlug() };
    } finally {
      db.close();
    }
  }
  // host mode — branch on session
  const host = loadHostConfig();
  const me = getCurrentPrincipal(request);
  if (!me) {
    return { mode: "host-anonymous" as const, host };
  }
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
  if (data.mode === "host" || data.mode === "host-anonymous") {
    return [{ title: `${data.host.name} · Doco` }];
  }
  return [{ title: "Recent · Doco" }];
}

export default function Home({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  if (loaderData.mode === "host") return <HostDashboard data={loaderData} />;
  if (loaderData.mode === "host-anonymous") return <HostLanding data={loaderData} />;
  return <SingleDocoRecent data={loaderData} />;
}

function HostLanding({
  data,
}: {
  data: Extract<Awaited<ReturnType<typeof loader>>, { mode: "host-anonymous" }>;
}) {
  // Onboarding wizard step 1 — pick intent. Per ADR-073.
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

function SingleDocoRecent({
  data,
}: {
  data: Extract<Awaited<ReturnType<typeof loader>>, { mode: "single-doco" }>;
}) {
  return (
    <div>
      <SiteHeader context={data.docoSlug} mode="single-doco" />
      <main className="mx-auto max-w-6xl px-6 py-6">
        <section className="mb-6 flex flex-col items-center gap-3 py-8">
          <DocoMark height={80} />
          <p className="max-w-xl text-center text-xs text-muted-foreground">
            Alignment framework + runtime checking. Documents and verifies user intent, agent
            reasoning, and agent actions — for {data.docoSlug}.
          </p>
        </section>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              Last 30 entities across decisions, intents, rules, actions, reasonings — chronological. (D-045)
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <div className="divide-y divide-border">
            {data.items.map((it) => (
              <div key={it.id} className="px-5 py-3.5">
                <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
                  <Badge variant={it.node_type === "decision" ? "accent" : "default"}>{it.node_type}</Badge>
                  {it.number ? <Badge variant="accent">{it.number}</Badge> : null}
                  <Link
                    to={`/e/${it.node_type}/${it.id}`}
                    className="text-sm font-semibold text-foreground hover:text-primary"
                  >
                    {it.title ?? it.slug ?? it.id}
                  </Link>
                </div>
                <div className="text-xs text-muted-foreground">
                  {it.summary} <span className="ml-1 font-mono">· {it.created_at}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </main>
    </div>
  );
}

// Suppress unused-import warning for CurrentPrincipal — used via `me` prop.
export type _ = CurrentPrincipal;
