import { Link } from "react-router";
import { openDb, getEvaloSlug } from "~/lib/db";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

const KNOWN = new Set([
  "principal",
  "intent",
  "rule",
  "decision",
  "action",
  "reasoning",
  "evaluation",
  "reference",
  "tag",
]);

export function loader({ params }: { params: { type: string } }) {
  const type = params.type;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  const db = openDb();
  try {
    const rows = db
      .prepare(`SELECT id, summary, raw_json FROM ${type} ORDER BY id DESC LIMIT 100`)
      .all() as { id: string; summary: string; raw_json: string }[];
    const items = rows.map((r) => {
      const ent = JSON.parse(r.raw_json) as Record<string, unknown>;
      return {
        id: r.id,
        summary: r.summary,
        slug: (ent.slug as string | undefined) ?? null,
        title: (ent.title as string | undefined) ?? null,
        name: (ent.name as string | undefined) ?? null,
        number: (ent.number as string | undefined) ?? null,
      };
    });
    return { items, type, evaloSlug: getEvaloSlug() };
  } finally {
    db.close();
  }
}

export function meta({ params }: { params: { type: string } }) {
  return [{ title: `${params.type}s · Evalo` }];
}

export default function ListByType({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { type, items } = loaderData;
  return (
    <div>
      <SiteHeader evaloSlug={loaderData.evaloSlug} />
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>
              {capitalize(type)}s <span className="ml-2 text-xs font-normal text-muted-foreground">({items.length})</span>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>id / slug</TableHead>
                <TableHead>summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.id}>
                  <TableCell>
                    <Link to={`/e/${type}/${it.id}`} className="text-primary hover:underline">
                      {it.slug ?? it.title ?? it.name ?? it.id}
                    </Link>
                    {it.number ? (
                      <Badge variant="accent" className="ml-2">
                        {it.number}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </main>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
