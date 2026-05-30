// Per-Doco edge detail at /<handle>/edges/<edge-id>.
//
// First-class edges (doco-vnext): the URL segment is the edge's surrogate id
// (edge_<ULID>). Renders the two connected nodes via EntityGraph, the edge's
// metadata (type / lifecycle / provenance / props), and its append-only
// version history (create / update / retire — who / when / why).

import { getVersions, withClient } from "@doco/db";
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { EntityGraph, type GraphLink, type GraphNode } from "~/components/entity-graph";
import { SiteHeader } from "~/components/site-header";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface EdgeRow {
  id: string;
  from_id: string;
  from_node_type: string;
  to_id: string;
  to_node_type: string;
  edge_type: string;
  props: Record<string, unknown> | null;
  lifecycle: string;
  created_at: string | null;
  created_by: string | null;
  updated_at: string | null;
  retired_at: string | null;
}

interface NodeLabel {
  id: string;
  summary: string | null;
  lifecycle: string | null;
  created_at: string | null;
}

export async function loader({
  params,
  request,
}: {
  params: { docoHandle: string; edgeKey: string };
  request: Request;
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { handle, ownerSlug } = ctx;
  const edgeId = params.edgeKey;

  return withClient(async (c) => {
    const edgeQuery = await c.query<EdgeRow>(
      `SELECT id, from_id, from_node_type, to_id, to_node_type, edge_type,
              props, lifecycle, created_at, created_by, updated_at, retired_at
         FROM edges
        WHERE doco_id = $1 AND id = $2`,
      [ctx.meta.docoId, edgeId],
    );
    const edge = edgeQuery.rows[0];
    if (!edge) {
      throw new Response("Edge not found", { status: 404 });
    }
    const labelRows = (
      await c.query<NodeLabel>(
        `WITH labels AS (
           SELECT id, split_part(decision, E'\n', 1) AS summary, lifecycle, created_at FROM decisions             WHERE doco_id = $1
           UNION ALL SELECT id, split_part(intent, E'\n', 1), lifecycle, created_at FROM intents                  WHERE doco_id = $1
           UNION ALL SELECT id, split_part(idea, E'\n', 1), lifecycle, created_at FROM ideas                    WHERE doco_id = $1
           UNION ALL SELECT id, split_part(rule, E'\n', 1), lifecycle, created_at FROM rules                    WHERE doco_id = $1
           UNION ALL SELECT id, policy, lifecycle, created_at FROM guidance_policies        WHERE doco_id = $1
           UNION ALL SELECT id, policy, lifecycle, created_at FROM node_authoring_policies  WHERE doco_id = $1
           UNION ALL SELECT id, split_part(action, E'\n', 1), lifecycle, created_at FROM actions                  WHERE doco_id = $1
           UNION ALL SELECT id, split_part(log, E'\n', 1), lifecycle, created_at FROM logs                     WHERE doco_id = $1
           UNION ALL SELECT id, split_part(eval, E'\n', 1), lifecycle, created_at FROM evals                    WHERE doco_id = $1
           UNION ALL SELECT id, split_part(reference, E'\n', 1), lifecycle, created_at FROM reference_entities       WHERE doco_id = $1
         )
         SELECT id, summary, lifecycle, created_at FROM labels WHERE id = ANY($2)`,
        [ctx.meta.docoId, [edge.from_id, edge.to_id]],
      )
    ).rows;
    const byId = new Map(labelRows.map((r) => [r.id, r] as const));
    const versions = await getVersions(c, "edge", edge.id);
    return {
      edge,
      versions,
      from_label: byId.get(edge.from_id) ?? null,
      to_label: byId.get(edge.to_id) ?? null,
      handle,
      ownerSlug,
      host: await loadHostConfig(),
      me: await getCurrentPrincipal(request),
    };
  });
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Edge · Doco" }];
  return [{ title: `${data.edge.edge_type} · ${data.handle} · Doco` }];
}

export default function EdgeDetail({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { edge, versions, from_label, to_label, handle, ownerSlug, me } = loaderData;

  const nodes: GraphNode[] = [
    {
      id: edge.from_id,
      entity_type: edge.from_node_type,
      summary: from_label?.summary ?? edge.from_id,
      name: null,
      lifecycle: from_label?.lifecycle ?? "asserted",
      created_at: from_label?.created_at ?? null,
      ppr: 1,
      gpr: 0,
      is_center: true,
    },
    {
      id: edge.to_id,
      entity_type: edge.to_node_type,
      summary: to_label?.summary ?? edge.to_id,
      name: null,
      lifecycle: to_label?.lifecycle ?? "asserted",
      created_at: to_label?.created_at ?? null,
      ppr: 0.5,
      gpr: 0,
    },
  ];
  const links: GraphLink[] = [
    {
      source: edge.from_id,
      target: edge.to_id,
      edge_type: edge.edge_type,
    },
  ];

  const propsEntries: [string, unknown][] = edge.props ? Object.entries(edge.props) : [];
  const isRetired = edge.lifecycle === "retired";

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Breadcrumb
          items={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: "Edges", to: `/${handle}/edges` },
            pageLabel: edge.edge_type,
          })}
        />
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">
            <Link
              to={`/${handle}/${edge.from_node_type}/${edge.from_id}`}
              className="text-primary hover:underline"
            >
              {from_label?.summary ?? edge.from_id}
            </Link>{" "}
            <code className="rounded bg-input px-1.5 py-0.5 font-mono text-base">
              {edge.edge_type}
            </code>{" "}
            <Link
              to={`/${handle}/${edge.to_node_type}/${edge.to_id}`}
              className="text-primary hover:underline"
            >
              {to_label?.summary ?? edge.to_id}
            </Link>
          </h1>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              isRetired ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
            }`}
          >
            {edge.lifecycle}
          </span>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Graph</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[420px] w-full">
              <EntityGraph
                centerId={edge.from_id}
                nodes={nodes}
                links={links}
                hrefFor={(id, nt) => `/${handle}/${nt}/${id}`}
                layoutMode="cluster"
                showPersonalizedRank={false}
                fillHeight
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 py-3">
            <CardTitle className="text-sm">Metadata</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-1 px-5 py-3 text-xs">
              <dt className="text-muted-foreground">id</dt>
              <dd>
                <code className="font-mono text-[11px]">{edge.id}</code>
              </dd>
              <dt className="text-muted-foreground">edge_type</dt>
              <dd>
                <code className="font-mono">{edge.edge_type}</code>
              </dd>
              <dt className="text-muted-foreground">lifecycle</dt>
              <dd>{edge.lifecycle}</dd>
              <dt className="text-muted-foreground">from</dt>
              <dd>
                <code className="font-mono text-[11px]">{edge.from_id}</code>{" "}
                <span className="text-muted-foreground">({edge.from_node_type})</span>
              </dd>
              <dt className="text-muted-foreground">to</dt>
              <dd>
                <code className="font-mono text-[11px]">{edge.to_id}</code>{" "}
                <span className="text-muted-foreground">({edge.to_node_type})</span>
              </dd>
              {edge.created_by ? (
                <>
                  <dt className="text-muted-foreground">created_by</dt>
                  <dd>
                    <code className="font-mono text-[11px]">{edge.created_by}</code>
                  </dd>
                </>
              ) : null}
              {propsEntries.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">props</dt>
                  <dd>
                    <pre className="overflow-auto rounded bg-input px-2 py-1.5 font-mono text-[11px]">
                      {JSON.stringify(edge.props, null, 2)}
                    </pre>
                  </dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 py-3">
            <CardTitle className="text-sm">History</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {versions.length === 0 ? (
              <p className="px-5 py-3 text-xs text-muted-foreground">No recorded history.</p>
            ) : (
              <ol className="divide-y divide-border">
                {[...versions].reverse().map((v) => (
                  <li key={v.version} className="flex items-baseline gap-3 px-5 py-2 text-xs">
                    <span
                      className={`min-w-[56px] font-medium capitalize ${
                        v.op === "retire"
                          ? "text-destructive"
                          : v.op === "create"
                            ? "text-primary"
                            : "text-foreground"
                      }`}
                    >
                      {v.op}
                    </span>
                    <span className="text-muted-foreground">v{v.version}</span>
                    {v.recorded_at ? (
                      <span className="text-muted-foreground">
                        {new Date(v.recorded_at).toLocaleString()}
                      </span>
                    ) : null}
                    {v.reason ? <span className="italic">“{v.reason}”</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
