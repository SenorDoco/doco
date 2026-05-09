import { Link } from "react-router";
import { openDb, getEvaloSlug } from "~/lib/db";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "~/components/card";

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
           SELECT id, 'rule' AS node_type, summary, created_at, slug, NULL, NULL FROM rule
           UNION ALL
           SELECT id, 'action' AS node_type, summary, created_at, NULL, NULL, NULL FROM action
           UNION ALL
           SELECT id, 'reasoning' AS node_type, summary, created_at, NULL, NULL, NULL FROM reasoning
         )
         ORDER BY created_at DESC LIMIT 30`,
      )
      .all() as {
      id: string;
      node_type: string;
      summary: string;
      created_at: string;
      slug: string | null;
      number: string | null;
      title: string | null;
    }[];
    return { items, evaloSlug: getEvaloSlug() };
  } finally {
    db.close();
  }
}

export function meta() {
  return [{ title: "Recent · Evalo" }];
}

export default function Recent({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  return (
    <div>
      <SiteHeader evaloSlug={loaderData.evaloSlug} />
      <main className="mx-auto max-w-6xl px-6 py-6">
        <section className="mb-6 flex flex-col items-center gap-3 py-8">
          <img src="/wordmark.svg" alt="Evalo" className="h-20 w-auto" />
          <p className="max-w-xl text-center text-xs text-muted-foreground">
            Alignment framework + runtime checking. Documents and verifies user intent, agent
            reasoning, and agent actions — for {loaderData.evaloSlug}.
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
            {loaderData.items.map((it) => (
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
