import { Link } from "react-router";
import { openEvaloDb } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export function loader({ params }: { params: { ownerSlug: string; evaloSlug: string } }) {
  const { ownerSlug, evaloSlug } = params;
  const db = openEvaloDb(ownerSlug, evaloSlug);
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
    return { items, ownerSlug, evaloSlug, host: loadHostConfig() };
  } finally {
    db.close();
  }
}

export function meta({ params }: { params: { ownerSlug: string; evaloSlug: string } }) {
  return [{ title: `${params.ownerSlug}/${params.evaloSlug} · Evalo` }];
}

export default function EvaloHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { items, ownerSlug, evaloSlug, host } = loaderData;
  return (
    <div>
      <SiteHeader
        context={host.name}
        mode="host"
        evaloScope={{ ownerSlug, evaloSlug }}
      />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>
              {ownerSlug}/{evaloSlug}
            </CardTitle>
            <CardDescription>
              Last 30 entities across this Evalo, chronological. (D-045)
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {items.length === 0 ? (
                <div className="px-5 py-6 text-xs text-muted-foreground">
                  This Evalo has no entities yet. Create some intents, rules, or decisions in
                  <code className="mx-1 rounded bg-input px-1">{`evalos/${ownerSlug}/${evaloSlug}/`}</code>
                  and run <code className="mx-1 rounded bg-input px-1">evalo reindex</code>.
                </div>
              ) : null}
              {items.map((it) => (
                <div key={it.id} className="px-5 py-3.5">
                  <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
                    <Badge variant={it.node_type === "decision" ? "accent" : "default"}>
                      {it.node_type}
                    </Badge>
                    {it.number ? <Badge variant="accent">{it.number}</Badge> : null}
                    <Link
                      to={`/${ownerSlug}/${evaloSlug}/e/${it.node_type}/${it.id}`}
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
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
