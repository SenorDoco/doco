import { Link } from "react-router";
import { openDb, getEvaloSlug } from "~/lib/db";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "~/components/card";
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

export function loader({ params }: { params: { type: string; id: string } }) {
  const type = params.type;
  const id = params.id;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  const db = openDb();
  try {
    const row = db.prepare(`SELECT raw_json FROM ${type} WHERE id = ?`).get(id) as
      | { raw_json: string }
      | undefined;
    if (!row) throw new Response(`Not found: ${id}`, { status: 404 });
    const ent = JSON.parse(row.raw_json) as Record<string, unknown>;
    const outgoing = db
      .prepare(
        "SELECT to_id, to_node_type, edge_type FROM edges WHERE from_id = ? ORDER BY edge_type, to_id",
      )
      .all(id) as { to_id: string; to_node_type: string; edge_type: string }[];
    const incoming = db
      .prepare(
        "SELECT from_id, from_node_type, edge_type FROM edges WHERE to_id = ? ORDER BY edge_type, from_id",
      )
      .all(id) as { from_id: string; from_node_type: string; edge_type: string }[];
    return { ent, outgoing, incoming, type, id, evaloSlug: getEvaloSlug() };
  } finally {
    db.close();
  }
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Entity · Evalo" }];
  const display =
    (data.ent.slug as string | undefined) ??
    (data.ent.title as string | undefined) ??
    (data.ent.name as string | undefined) ??
    data.id;
  return [{ title: `${display} · Evalo` }];
}

export default function EntityDetail({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ent, type, id, outgoing, incoming } = loaderData;
  const display =
    (ent.slug as string | undefined) ??
    (ent.title as string | undefined) ??
    (ent.name as string | undefined) ??
    id;
  return (
    <div>
      <SiteHeader evaloSlug={loaderData.evaloSlug} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-[11px]">{id}</CardDescription>
            <CardTitle className="text-lg">{display}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <Badge>{type}</Badge>
              {ent.number ? <Badge variant="accent">{String(ent.number)}</Badge> : null}
              {ent.lifecycle ? <Badge>lifecycle: {String(ent.lifecycle)}</Badge> : null}
              {ent.status ? <Badge>status: {String(ent.status)}</Badge> : null}
              {ent.modality ? <Badge variant="primary">{String(ent.modality)}</Badge> : null}
              {ent.phase ? <Badge variant="primary">{String(ent.phase)}</Badge> : null}
            </div>
            {ent.summary ? <p className="text-xs text-muted-foreground">{String(ent.summary)}</p> : null}
          </CardContent>
        </Card>

        {outgoing.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Edges (outgoing)</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>edge type</TableHead>
                    <TableHead>target</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outgoing.map((e) => (
                    <TableRow key={`${e.edge_type}-${e.to_id}`}>
                      <TableCell className="font-mono text-xs">{e.edge_type}</TableCell>
                      <TableCell>
                        <Link to={`/e/${e.to_node_type}/${e.to_id}`} className="text-primary hover:underline">
                          {e.to_id}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">({e.to_node_type})</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        {incoming.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Edges (incoming)</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>edge type</TableHead>
                    <TableHead>source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {incoming.map((e) => (
                    <TableRow key={`${e.edge_type}-${e.from_id}`}>
                      <TableCell className="font-mono text-xs">{e.edge_type}</TableCell>
                      <TableCell>
                        <Link to={`/e/${e.from_node_type}/${e.from_id}`} className="text-primary hover:underline">
                          {e.from_id}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">({e.from_node_type})</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Raw entity</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border border-border bg-input p-3 text-[12px] leading-snug">
              {JSON.stringify(ent, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
