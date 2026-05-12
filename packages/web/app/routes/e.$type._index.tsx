import { Link } from "react-router";
import { openDb, getDocoSlug } from "~/lib/db";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

const KNOWN = new Set([
  "principal",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "reasoning",
  "evaluation",
  "reference",
  "scope",
]);

export function loader({ request, params }: { request: Request; params: { type: string } }) {
  const type = params.type;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  // ADR-079: ?scope=<id>&scope=<id> filters entities by scope membership.
  // Default semantics = intersection (must be in ALL selected scopes).
  // ?scope_mode=any switches to union.
  const url = new URL(request.url);
  const selectedScopes = url.searchParams.getAll("scope");
  const scopeMode = url.searchParams.get("scope_mode") === "any" ? "any" : "all";
  const db = openDb();
  try {
    let rows: { id: string; summary: string; raw_json: string }[];
    if (selectedScopes.length === 0) {
      rows = db
        .prepare(`SELECT id, summary, raw_json FROM ${type} ORDER BY id DESC LIMIT 100`)
        .all() as { id: string; summary: string; raw_json: string }[];
    } else {
      // Build the scope filter via a join on the edges table.
      const placeholders = selectedScopes.map(() => "?").join(",");
      // For "all" semantics, use HAVING COUNT(*) = N to require all scopes.
      const havingClause =
        scopeMode === "all" ? `HAVING COUNT(DISTINCT e.to_id) = ${selectedScopes.length}` : "";
      const sql = `
        SELECT t.id, t.summary, t.raw_json
        FROM ${type} t
        JOIN edges e ON e.from_id = t.id AND e.edge_type = 'in_scope_of'
        WHERE e.to_id IN (${placeholders})
        GROUP BY t.id
        ${havingClause}
        ORDER BY t.id DESC
        LIMIT 100
      `;
      rows = db.prepare(sql).all(...selectedScopes) as {
        id: string;
        summary: string;
        raw_json: string;
      }[];
    }
    // Resolve scope names for the UI's chips.
    const allScopes = db
      .prepare("SELECT id, name FROM scope ORDER BY name")
      .all() as { id: string; name: string }[];
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
    return { items, type, docoSlug: getDocoSlug(), allScopes, selectedScopes, scopeMode };
  } finally {
    db.close();
  }
}

export function meta({ params }: { params: { type: string } }) {
  return [{ title: `${params.type}s · Doco` }];
}

export default function ListByType({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { type, items, allScopes, selectedScopes, scopeMode } = loaderData;
  // Build URLs to add/remove scopes from the filter.
  function urlWithScopes(scopes: string[], mode = scopeMode): string {
    const u = new URLSearchParams();
    for (const s of scopes) u.append("scope", s);
    if (mode === "any") u.set("scope_mode", "any");
    return u.toString() ? `?${u.toString()}` : "";
  }
  return (
    <div>
      <SiteHeader context={loaderData.docoSlug} />
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>
              {capitalize(type)}s <span className="ml-2 text-xs font-normal text-muted-foreground">({items.length})</span>
            </CardTitle>
          </CardHeader>
          <div className="px-5 pb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                Scopes ({selectedScopes.length} selected, mode:{" "}
                <Link
                  to={urlWithScopes(selectedScopes, scopeMode === "all" ? "any" : "all")}
                  className="text-primary hover:underline"
                >
                  {scopeMode}
                </Link>
                ):
              </span>
              {allScopes.map((s) => {
                const active = selectedScopes.includes(s.id);
                const next = active
                  ? selectedScopes.filter((x) => x !== s.id)
                  : [...selectedScopes, s.id];
                return (
                  <Link
                    key={s.id}
                    to={urlWithScopes(next)}
                    className={
                      active
                        ? "rounded-full border border-primary bg-primary px-2 py-0.5 text-primary-foreground"
                        : "rounded-full border border-border px-2 py-0.5 hover:border-primary"
                    }
                  >
                    {s.name}
                  </Link>
                );
              })}
              {selectedScopes.length > 0 ? (
                <Link to="" className="text-muted-foreground hover:text-foreground">
                  clear
                </Link>
              ) : null}
            </div>
          </div>
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
