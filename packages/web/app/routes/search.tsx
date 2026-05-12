import { Form, Link, useSearchParams } from "react-router";
import { findRules, Glossary } from "@doco/discovery";
import { rootDir, getDocoSlug, openDb } from "~/lib/db";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const docoSlug = getDocoSlug();
  if (!q) return { q, fts: [], findRulesResult: null, docoSlug };
  const db = openDb();
  try {
    const fts = db
      .prepare(`SELECT id, node_type, summary FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 20`)
      .all(q) as { id: string; node_type: string; summary: string }[];
    const glossary = await Glossary.load(rootDir());
    const findRulesResult = findRules(db, glossary, { description: q });
    return { q, fts, findRulesResult, docoSlug };
  } finally {
    db.close();
  }
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  return [{ title: data?.q ? `Search: ${data.q} · Doco` : "Search · Doco" }];
}

export default function Search({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  return (
    <div>
      <SiteHeader context={loaderData.docoSlug} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Form method="get" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            autoFocus
            placeholder="Search entities or describe a Rule context..."
            className="flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Search
          </button>
        </Form>

        {!loaderData.q ? (
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">
                Enter a query above. Searches summary + body via FTS5; finds applicable Rules via the
                5-strategy retrieval (D-030).
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">FTS matches ({loaderData.fts.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>type</TableHead>
                      <TableHead>id / summary</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loaderData.fts.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Badge>{r.node_type}</Badge>
                        </TableCell>
                        <TableCell>
                          <Link to={`/e/${r.node_type}/${r.id}`} className="text-primary hover:underline">
                            {r.id}
                          </Link>
                          <div className="text-xs text-muted-foreground">{r.summary}</div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {loaderData.findRulesResult ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">find-rules</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Tier title="PRECISE (structural)" hits={loaderData.findRulesResult.precise} />
                  <Tier title="RELATED (tag overlap)" hits={loaderData.findRulesResult.related} />
                  <Tier
                    title="POSSIBLY RELEVANT (semantic / FTS)"
                    hits={loaderData.findRulesResult.possiblyRelevant}
                  />
                </CardContent>
              </Card>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function Tier({
  title,
  hits,
}: {
  title: string;
  hits: { rule_id: string; rule_slug: string | null; modality: string; phase: string; summary: string; reason?: string | undefined }[];
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {hits.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">(no hits)</div>
      ) : (
        <ul className="space-y-2">
          {hits.map((h) => (
            <li key={h.rule_id} className="flex items-start gap-2">
              <Badge variant="primary">
                {h.modality}/{h.phase}
              </Badge>
              <div>
                <Link to={`/e/rule/${h.rule_id}`} className="text-sm text-primary hover:underline">
                  {h.rule_slug ?? h.rule_id}
                </Link>
                <div className="text-xs text-muted-foreground">{h.summary}</div>
                {h.reason ? <div className="text-[11px] text-muted-foreground italic">{h.reason}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
