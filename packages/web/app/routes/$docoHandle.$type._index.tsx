import { ALL_ENTITY_TABLES, DOCO_NEURON_TABLE_SPECS, withClient } from "@doco/db";
import { entityUrl, isEntityType } from "@doco/shared";
// Per-Doco entity list at the short URL `/<doco-handle>/<type>`.
//
// Note: this route IS the catch-all for any unknown `<type>` segment
// under `/<doco-handle>/`. The static per-Doco routes (settings,
// search, status.json, api/*) are registered before this in routes.ts
// and win the match. For an unrecognized type we return 404.
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";

const TABLE_BY_TYPE: Record<string, string> = Object.fromEntries(
  DOCO_NEURON_TABLE_SPECS.map((spec) => [spec.entityType, spec.table]),
);
const KNOWN = new Set<string>(Object.keys(TABLE_BY_TYPE));

export async function loader({
  params,
  request,
}: {
  params: { docoId: string; type: string };
  request: Request;
}) {
  const { type } = params;
  if (!KNOWN.has(type)) {
    throw new Response("Unknown type", { status: 404 });
  }
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  return withClient(async (c) => {
    const table = TABLE_BY_TYPE[type] ?? type;
    // Post-migration: all 9 neuron tables here carry prose in the
    // type-named column (intent on intents, decision on decisions,
    // ...). Project the first line for the list "summary" cell.
    const tnCol = ALL_ENTITY_TABLES[type]?.typeNamedColumn ?? "summary";
    const rows = (
      await c.query<{ id: string; summary: string; data: Record<string, unknown> | null }>(
        `SELECT id, split_part(${tnCol}, E'\n', 1) AS summary, data FROM ${table}
          WHERE doco_id = $1
          ORDER BY id DESC LIMIT 200`,
        [ctx.meta.docoId],
      )
    ).rows;
    const items = rows.map((r) => {
      const ent = r.data ?? {};
      return {
        id: r.id,
        summary: r.summary,
        title: (ent.title as string | undefined) ?? null,
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
  return [{ title: `${params.type}s · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function ListByTypeInDoco({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { items, type, ownerSlug, docoSlug, handle, host: _host, me } = loaderData;

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Breadcrumb
          items={docoBreadcrumb({ ownerSlug, handle, pageLabel: `${capitalize(type)}s` })}
        />
        <Card>
          <CardHeader>
            <CardTitle>
              {capitalize(type)}s{" "}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({items.length})
              </span>
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
                      to={entityUrl({ docoHandle: handle, entityType: type, id: it.id })}
                      className="text-primary hover:underline"
                    >
                      {it.title ?? it.name ?? it.id}
                    </Link>
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
  return s
    .split("_")
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

export { isEntityType };
