import { Link } from "react-router";
import { openEvaloDb } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

const KNOWN = new Set([
  "principal",
  "organization",
  "intent",
  "rule",
  "decision",
  "action",
  "reasoning",
  "evaluation",
  "reference",
  "tag",
]);

export function loader({
  params,
  request,
}: {
  params: { ownerSlug: string; evaloSlug: string; type: string };
  request: Request;
}) {
  const { ownerSlug, evaloSlug, type } = params;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  const db = openEvaloDb(ownerSlug, evaloSlug);
  try {
    const rows = db
      .prepare(`SELECT id, summary, raw_json FROM ${type} ORDER BY id DESC LIMIT 200`)
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
    return {
      items,
      type,
      ownerSlug,
      evaloSlug,
      host: loadHostConfig(),
      me: getCurrentPrincipal(request),
    };
  } finally {
    db.close();
  }
}

export function meta({ params }: { params: { ownerSlug: string; evaloSlug: string; type: string } }) {
  return [{ title: `${params.type}s · ${params.ownerSlug}/${params.evaloSlug} · Evalo` }];
}

export default function ListByTypeInEvalo({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { items, type, ownerSlug, evaloSlug, host, me } = loaderData;
  return (
    <div>
      <SiteHeader context={host.name} mode="host" me={me} evaloScope={{ ownerSlug, evaloSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>
              {capitalize(type)}s{" "}
              <span className="ml-2 text-xs font-normal text-muted-foreground">({items.length})</span>
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
                    <Link to={`/${ownerSlug}/${evaloSlug}/e/${type}/${it.id}`} className="text-primary hover:underline">
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
