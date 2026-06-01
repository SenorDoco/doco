// Per-Doco edge list at /<handle>/edges.
//
// Doco's edges are derived from reference fields on nodes (D-017,
// fields-as-edges). They have no surrogate id — composite PK is
// (from_id, to_id, edge_type). This page surfaces the whole edge set
// of the Doco so a human (or the in-page assistant) can scan how
// nodes connect, and click through to a single edge's detail view.
//
// Listing is ordered by edge_type, then from_id, then to_id — stable
// and predictable. We render summaries from the joined node tables
// (best-effort UNION across every entity table) so each row reads as
// "<from-summary> --serves--> <to-summary>" instead of bare IDs.

import { withClient } from "@doco/db";
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface EdgeRow {
  id: string;
  from_id: string;
  from_node_type: string;
  from_summary: string | null;
  to_id: string;
  to_node_type: string;
  to_summary: string | null;
  edge_type: string;
  lifecycle: string;
}

export async function loader({
  params,
  request,
}: {
  params: { docoHandle: string };
  request: Request;
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  const edgeTypeFilter = new URL(request.url).searchParams.get("edge_type")?.trim() || null;
  return withClient(async (c) => {
    const queryParams: unknown[] = [ctx.meta.docoId];
    const where = ["e.doco_id = $1", "e.lifecycle <> 'retired'"];
    if (edgeTypeFilter) {
      queryParams.push(edgeTypeFilter);
      where.push(`e.edge_type = $${queryParams.length}`);
    }

    const rows = (
      await c.query<EdgeRow>(
        // Post-collapse: the prose node types live in `nodes` (summary =
        // first line of `prose`); policies keep their own tables and
        // `policy` column. Matches the prior set (no states/principals).
        `WITH labels AS (
           SELECT id, split_part(prose, E'\n', 1) AS summary
             FROM nodes
            WHERE doco_id = $1
              AND node_type IN ('decision', 'intent', 'idea', 'rule', 'action', 'log', 'eval', 'reference')
           UNION ALL SELECT id, policy FROM guidance_policies        WHERE doco_id = $1
           UNION ALL SELECT id, policy FROM node_authoring_policies  WHERE doco_id = $1
         )
         SELECT e.id, e.from_id, e.from_node_type, fl.summary AS from_summary,
                e.to_id,   e.to_node_type,   tl.summary AS to_summary,
                e.edge_type, e.lifecycle
           FROM edges e
           LEFT JOIN labels fl ON fl.id = e.from_id
           LEFT JOIN labels tl ON tl.id = e.to_id
          WHERE ${where.join(" AND ")}
          ORDER BY e.edge_type, e.from_id, e.to_id
          LIMIT 500`,
        queryParams,
      )
    ).rows;
    return {
      edges: rows,
      edgeTypeFilter,
      handle,
      ownerSlug,
      docoSlug,
      host: await loadHostConfig(),
      me: await getCurrentPrincipal(request),
    };
  });
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Edges · Doco" }];
  return [{ title: `Edges · ${data.handle} · Doco` }];
}

export default function EdgesIndex({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { edges, edgeTypeFilter, handle, ownerSlug, me } = loaderData;
  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Edges" })} />
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">Edges</h1>
          <div className="text-xs text-muted-foreground">
            {edges.length} edge{edges.length === 1 ? "" : "s"}
          </div>
        </header>
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <CardTitle className="text-sm">
              {edgeTypeFilter ? `${edgeTypeFilter} edges` : "Every edge in this Doco"}
            </CardTitle>
            {edgeTypeFilter ? (
              <Link to={`/${handle}/edges`} className="text-xs text-primary hover:underline">
                All edge types
              </Link>
            ) : null}
          </CardHeader>
          <CardContent className="p-0">
            {edges.length === 0 ? (
              <p className="px-5 py-6 text-xs text-muted-foreground">
                No edges yet. Edges materialize automatically when a node references another node
                (e.g. a Decision's intent_ids). Patch a node's reference field and the edge appears.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[28%]">From</TableHead>
                    <TableHead className="w-[18%]">Edge</TableHead>
                    <TableHead className="w-[34%]">To</TableHead>
                    <TableHead className="w-[18%] text-right">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {edges.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <Link
                          to={`/${handle}/${e.from_node_type}/${e.from_id}`}
                          className="text-primary hover:underline"
                        >
                          {e.from_summary ?? e.from_id}
                        </Link>
                        <div className="text-[10px] text-muted-foreground">{e.from_node_type}</div>
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-input px-1.5 py-0.5 font-mono text-[11px]">
                          {e.edge_type}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/${handle}/${e.to_node_type}/${e.to_id}`}
                          className="text-primary hover:underline"
                        >
                          {e.to_summary ?? e.to_id}
                        </Link>
                        <div className="text-[10px] text-muted-foreground">{e.to_node_type}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          to={`/${handle}/edges/${e.id}`}
                          className="text-xs text-primary hover:underline"
                        >
                          open →
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
