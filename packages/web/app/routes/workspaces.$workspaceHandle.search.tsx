// /workspaces/:workspaceHandle/search — workspace-level semantic search.
//
// Aggregates embeddings across the workspace's Docos the caller can read, scores against
// the query embedding, and hydrates the top results with their per-Doco
// context (handle + entity URL). Vector-only ranking — no facet
// filtering yet (a follow-up to the doco-level search, which carries
// lifecycle / node-type filters).

import { DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS, rankEmbeddings, withClient } from "@doco/db";
import type { PoolClient } from "pg";
import { Form, Link } from "react-router";
import { LifecycleBadge, NodeTypeBadge } from "~/components/badge";
import { workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { loadHostConfig } from "~/lib/host.server";
import { nodeTypePlural } from "~/lib/node-colors";
import { getCurrentPrincipal } from "~/lib/session.server";
import { timeAgo } from "~/lib/time-ago";
import { loadWorkspaceForRead } from "~/lib/workspace-helpers.server";

const RESULTS_LIMIT = 50;

interface Hit {
  id: string;
  node_type: string;
  summary: string;
  lifecycle: string | null;
  created_at: string | null;
  docoId: string;
  docoHandle: string;
  vector_score: number;
}

const TYPE_SPECS = DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS;

async function hydrateHits(
  c: PoolClient,
  ids: string[],
  scoreById: Map<string, number>,
  docoIdByEntity: Map<string, string>,
  docoHandleById: Map<string, string>,
): Promise<Hit[]> {
  if (ids.length === 0) return [];
  const hits: Hit[] = [];
  for (const spec of TYPE_SPECS) {
    // Post-collapse: every generic capture node type lives in `nodes` with
    // prose in the shared
    // `prose` column. Scope by node_type.
    const rows = (
      await c.query<{
        id: string;
        summary: string | null;
        lifecycle: string | null;
        created_at: string | Date | null;
      }>(
        `SELECT id, split_part(prose, E'\n', 1) AS summary, lifecycle, created_at::text AS created_at
           FROM nodes
          WHERE id = ANY($1::text[]) AND node_type = $2`,
        [ids, spec.nodeType],
      )
    ).rows;
    for (const row of rows) {
      const id = String(row.id);
      const docoId = docoIdByEntity.get(id);
      if (!docoId) continue;
      const docoHandle = docoHandleById.get(docoId);
      if (!docoHandle) continue;
      hits.push({
        id,
        node_type: spec.nodeType,
        summary: row.summary ?? "",
        lifecycle: row.lifecycle,
        created_at: row.created_at ? String(row.created_at) : null,
        docoId,
        docoHandle,
        vector_score: scoreById.get(id) ?? 0,
      });
    }
  }
  // Sort by score desc — same order as input, but UNION ALL across tables
  // groups by type first.
  hits.sort((a, b) => b.vector_score - a.vector_score);
  return hits;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const me = await getCurrentPrincipal(request);
  const { workspace, docos: docoRows } = await loadWorkspaceForRead(
    params.workspaceHandle,
    me?.id ?? null,
  );
  const host = await loadHostConfig();
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  return withClient(async (c) => {
    const docoIds = docoRows.map((r) => r.id);
    const docoHandleById = new Map(docoRows.map((r) => [r.id, r.handle]));

    if (!q || docoIds.length === 0) {
      return {
        workspace,
        me,
        host,
        q,
        hits: [] as Hit[],
        warning: null as string | null,
      };
    }

    const provider = getDocoEmbeddingProvider();
    if (!provider) {
      return {
        workspace,
        me,
        host,
        q,
        hits: [] as Hit[],
        warning: "Vector search unavailable: no embedding provider configured (OPENAI_API_KEY).",
      };
    }

    let queryEmbedding: Float32Array;
    try {
      const [v] = await provider.embed([q], "query");
      if (!v || v.length === 0) {
        return {
          workspace,
          me,
          host,
          q,
          hits: [] as Hit[],
          warning: "Vector search unavailable: provider returned empty embedding.",
        };
      }
      queryEmbedding = v;
    } catch (e) {
      return {
        workspace,
        me,
        host,
        q,
        hits: [] as Hit[],
        warning: `Vector search unavailable: ${(e as Error).message}`,
      };
    }

    // Only vectors from the query's own model are comparable: after a
    // provider switch, older rows hold another model's vectors until the
    // embedding sweep replaces them.
    const top = await rankEmbeddings(c, {
      docoIds,
      source: "node",
      modelId: provider.modelId,
      queryEmbedding,
      limit: RESULTS_LIMIT,
    });
    if (top.length === 0) {
      return {
        workspace,
        me,
        host,
        q,
        hits: [] as Hit[],
        warning: "No embeddings across this workspace's Docos yet — they fill in within minutes.",
      };
    }
    const scoreById = new Map(top.map((t) => [t.entity_id, t.score]));
    const docoIdByEntity = new Map(top.map((t) => [t.entity_id, t.doco_id]));
    const ids = top.map((t) => t.entity_id);

    const hits = await hydrateHits(c, ids, scoreById, docoIdByEntity, docoHandleById);
    return { workspace, me, host, q, hits, warning: null };
  });
}

export function meta({ params }: { params: { workspaceHandle: string } }) {
  return [{ title: `Search · ${params.workspaceHandle} · Doco` }];
}

export default function WorkspaceSearch({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { workspace, me, q, hits, warning } = loaderData;
  return (
    <div>
      <SiteHeader me={me} />
      <SingleColumnPageMain className="py-6 space-y-5">
        <PageHeader
          breadcrumb={workspaceBreadcrumb({ workspaceSlug: workspace.handle, pageLabel: "Search" })}
          title={`Search across ${workspace.handle}`}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <section className="min-w-0 space-y-4">
            <Form method="get" className="flex gap-2">
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder={`Search across this workspace's Docos...`}
                className="w-full rounded-md px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              />
              <button
                type="submit"
                className="neu-button rounded-md px-4 py-2.5 text-sm font-semibold text-foreground"
              >
                Search
              </button>
            </Form>

            {warning ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {warning}
              </div>
            ) : null}

            {q ? (
              <Card>
                <CardHeader className="px-4 py-3">
                  <CardTitle className="text-sm">
                    {hits.length} {hits.length === 1 ? "result" : "results"} for "{q}"
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {hits.length === 0 ? (
                    <p className="px-5 pb-5 text-xs italic text-muted-foreground">No matches.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {hits.map((h) => (
                        <li key={h.id} className="px-5 py-3 text-sm">
                          <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <Link
                              to={`/${h.docoHandle}/${h.node_type}/${h.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              <span aria-hidden className="mr-1.5">
                                <NodeTypeIcon nodeType={h.node_type} />
                              </span>
                              {h.summary || h.id}
                            </Link>
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                              {h.vector_score.toFixed(3)}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <NodeTypeBadge nodeType={h.node_type}>
                              {nodeTypePlural(h.node_type)}
                            </NodeTypeBadge>
                            {h.lifecycle ? <LifecycleBadge lifecycle={h.lifecycle} /> : null}
                            <Link
                              to={`/${h.docoHandle}`}
                              className="hover:text-foreground hover:underline"
                            >
                              {h.docoHandle}
                            </Link>
                            {h.created_at ? (
                              <time
                                dateTime={h.created_at}
                                title={h.created_at}
                                suppressHydrationWarning
                              >
                                {timeAgo(h.created_at)}
                              </time>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ) : null}
          </section>

          <aside className="min-w-0 space-y-4">
            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Workspace</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Link
                  to={`/workspaces/${workspace.handle}`}
                  className="block font-semibold text-foreground hover:text-primary"
                >
                  {workspace.handle}
                </Link>
                <Link
                  to={`/workspaces/${workspace.handle}/integrations`}
                  className="block text-xs text-muted-foreground hover:text-foreground"
                >
                  App integrations
                </Link>
              </CardContent>
            </Card>
          </aside>
        </div>
      </SingleColumnPageMain>
    </div>
  );
}
