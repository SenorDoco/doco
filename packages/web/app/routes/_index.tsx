import { Link } from "react-router";
import { getDocoSlug, openDb } from "~/lib/db";
import { SiteHeader } from "~/components/site-header";
import { DocoMark } from "~/components/doco-mark";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { RecentFeed } from "~/components/recent-feed";

export interface RecentItem {
  id: string;
  node_type: string;
  summary: string;
  created_at: string;
  slug: string | null;
  number: string | null;
  title: string | null;
}

export function loader() {
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
         WHERE created_at IS NOT NULL
         ORDER BY created_at ASC LIMIT 200`,
      )
      .all() as RecentItem[];
    return { items, docoSlug: getDocoSlug() };
  } finally {
    db.close();
  }
}

export function meta() {
  return [{ title: "Recent · Doco" }];
}

export default function Home({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  return (
    <div>
      <SiteHeader context={loaderData.docoSlug} />
      <main className="mx-auto max-w-6xl px-6 py-6">
        <section className="mb-6 flex flex-col items-center gap-3 py-8">
          <DocoMark height={80} />
          <p className="max-w-xl text-center text-xs text-muted-foreground">
            Alignment framework + runtime checking. Documents and verifies user intent, agent
            reasoning, and agent actions — for {loaderData.docoSlug}.
          </p>
        </section>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              Chronological — oldest at top, newest at bottom. Auto-refreshes (ADR-089).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecentFeed initialItems={loaderData.items} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

// Single-item card; exported so the live <RecentFeed> can reuse it.
export function RecentItemRow({ it }: { it: RecentItem }) {
  return (
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
  );
}
