import { DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS, withClient } from "@doco/db";
import { entityUrl, normalizeNodeType } from "@doco/shared";
// Per-Doco entity list at the short URL `/<doco-handle>/<type>`.
//
// Note: this route IS the catch-all for any unknown `<type>` segment
// under `/<doco-handle>/`. The static per-Doco routes (settings,
// search, status.json, api/*) are registered before this in routes.ts
// and win the match. For an unrecognized type we return 404.
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { cn } from "~/lib/cn";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";

// The generic prose node types this list route serves; each is a `node_type`
// value on the unified `nodes` table.
const KNOWN = new Set<string>(DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS.map((spec) => spec.nodeType));

export async function loader({
  params,
  request,
}: {
  params: { docoId: string; type: string };
  request: Request;
}) {
  const type = normalizeNodeType(params.type);
  if (!type || !KNOWN.has(type)) {
    throw new Response("Unknown type", { status: 404 });
  }
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  return withClient(async (c) => {
    // Post-collapse: all 9 node types live in `nodes` with prose in the
    // shared `prose` column. Project its first line for the list
    // "summary" cell, scoped by node_type.
    const rows = (
      await c.query<{ id: string; summary: string; data: Record<string, unknown> | null }>(
        `SELECT id, split_part(prose, E'\n', 1) AS summary, extra AS data FROM nodes
          WHERE node_type = $1 AND doco_id = $2
          ORDER BY id DESC LIMIT 200`,
        [type, ctx.meta.docoId],
      )
    ).rows;
    const items = rows.map((r) => {
      const ent = r.data ?? {};
      return {
        id: r.id,
        summary: r.summary,
        name: (ent.name as string | undefined) ?? null,
      };
    });
    return {
      items,
      type,
      ownerSlug,
      docoSlug,
      handle,
      host: await loadHostConfig(),
      me: await getCurrentPrincipal(request),
    };
  });
}

export function meta({
  params,
}: {
  params: { docoHandle?: string; docoId?: string; type: string };
}) {
  const type = normalizeNodeType(params.type) ?? params.type;
  return [{ title: `${capitalize(type)}s · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function ListByTypeInDoco({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { items, type, ownerSlug, docoSlug, handle, host: _host } = loaderData;

  return (
    <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
      <Breadcrumb
        items={docoBreadcrumb({ ownerSlug, handle, pageLabel: `${capitalize(type)}s` })}
      />
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
              <TableHead>id</TableHead>
              <TableHead>summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((it) => (
              <TableRow key={it.id}>
                <TableCell>
                  <Link
                    to={entityUrl({ docoHandle: handle, nodeType: type, id: it.id })}
                    className={cn("text-primary hover:underline", !it.name && "font-mono")}
                  >
                    {it.name ?? it.id}
                  </Link>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{it.summary}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </main>
  );
}

function capitalize(s: string): string {
  return s
    .split("_")
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}
