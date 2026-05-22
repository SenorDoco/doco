// /orgs/:orgHandle/search — org-level semantic search.
//
// Aggregates embeddings across every Doco the org owns, scores against
// the query embedding, and hydrates the top results with their per-Doco
// context (handle + entity URL). Vector-only ranking — no facet
// filtering yet (a follow-up to the doco-level search, which carries
// lifecycle / node-type filters).

import { bufferToEmbedding, cosineSimilarity, withClient } from "@doco/db";
import type { PoolClient } from "pg";
import { Form, Link } from "react-router";
import { LifecycleBadge, NodeTypeBadge } from "~/components/badge";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { SiteHeader } from "~/components/site-header";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { loadHostConfig } from "~/lib/host";
import { nodeTypePlural } from "~/lib/neuron-colors";
import { getCurrentPrincipal } from "~/lib/session";
import { timeAgo } from "~/lib/time-ago";

const RESULTS_LIMIT = 50;

interface OrgRow {
  id: string;
  slug: string;
  handle: string;
  name: string;
}

interface Hit {
  id: string;
  entity_type: string;
  summary: string;
  lifecycle: string | null;
  created_at: string | null;
  docoId: string;
  docoHandle: string;
  vector_score: number;
}

// Note tables only — articles are constitution metadata, not nodes,
// and don't participate in org-wide search. They are reachable via
// /<handle>/constitution and /<handle>/api/articles.json.
const TYPE_SPECS = [
  { table: "decisions", entityType: "decision" },
  { table: "intents", entityType: "intent" },
  { table: "ideas", entityType: "idea" },
  { table: "rules", entityType: "rule" },
  { table: "actions", entityType: "action" },
  { table: "logs", entityType: "log" },
  { table: "evals", entityType: "eval" },
  { table: "reference_entities", entityType: "reference" },
  { table: "states", entityType: "state" },
] as const;

async function resolveOrgByHandle(orgHandle: string): Promise<OrgRow | null> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; slug: string; handle: string | null; name: string }>(
      `SELECT id, slug, handle, name FROM organizations
        WHERE handle = $1 OR slug = $1
        LIMIT 1`,
      [orgHandle],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      slug: String(row.slug),
      handle: String(row.handle ?? row.slug),
      name: String(row.name),
    };
  });
}

async function getEmbeddingsForDocos(
  c: PoolClient,
  docoIds: string[],
): Promise<{ entity_id: string; doco_id: string; embedding: Float32Array }[]> {
  if (docoIds.length === 0) return [];
  const r = await c.query<{ entity_id: string; doco_id: string; embedding: Buffer }>(
    "SELECT entity_id, doco_id, embedding FROM embeddings WHERE doco_id = ANY($1::text[])",
    [docoIds],
  );
  return r.rows.map((row) => ({
    entity_id: String(row.entity_id),
    doco_id: String(row.doco_id),
    embedding: bufferToEmbedding(row.embedding),
  }));
}

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
    const rows = (
      await c.query<{
        id: string;
        summary: string | null;
        lifecycle: string | null;
        created_at: string | Date | null;
      }>(
        `SELECT id, summary, lifecycle, created_at::text AS created_at
           FROM ${spec.table}
          WHERE id = ANY($1::text[])`,
        [ids],
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
        entity_type: spec.entityType,
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
  params: { orgHandle: string };
}) {
  const org = await resolveOrgByHandle(params.orgHandle);
  if (!org) {
    throw new Response(`Org "${params.orgHandle}" not found.`, { status: 404 });
  }
  const me = await getCurrentPrincipal(request);
  const host = await loadHostConfig();
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  return withClient(async (c) => {
    const docoRows = (
      await c.query<{ id: string; handle: string }>(
        "SELECT id, handle FROM docos WHERE owner_id = $1",
        [org.id],
      )
    ).rows;
    const docoIds = docoRows.map((r) => String(r.id));
    const docoHandleById = new Map(docoRows.map((r) => [String(r.id), String(r.handle)]));

    if (!q || docoIds.length === 0) {
      return {
        org,
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
        org,
        me,
        host,
        q,
        hits: [] as Hit[],
        warning: "Vector search unavailable: no embedding provider configured (OPENAI_API_KEY).",
      };
    }

    let queryEmbedding: Float32Array;
    try {
      const [v] = await provider.embed([q]);
      if (!v || v.length === 0) {
        return {
          org,
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
        org,
        me,
        host,
        q,
        hits: [] as Hit[],
        warning: `Vector search unavailable: ${(e as Error).message}`,
      };
    }

    const all = await getEmbeddingsForDocos(c, docoIds);
    if (all.length === 0) {
      return {
        org,
        me,
        host,
        q,
        hits: [] as Hit[],
        warning: "No embeddings across this org's Docos yet — reindex first.",
      };
    }
    const scored = all.map((e) => ({
      entity_id: e.entity_id,
      doco_id: e.doco_id,
      score: cosineSimilarity(queryEmbedding, e.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, RESULTS_LIMIT);
    const scoreById = new Map(top.map((t) => [t.entity_id, t.score]));
    const docoIdByEntity = new Map(top.map((t) => [t.entity_id, t.doco_id]));
    const ids = top.map((t) => t.entity_id);

    const hits = await hydrateHits(c, ids, scoreById, docoIdByEntity, docoHandleById);
    return { org, me, host, q, hits, warning: null };
  });
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `Search · ${params.orgHandle} · Doco` }];
}

export default function OrgSearch({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { org, me, q, hits, warning } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-5xl px-6 py-6 space-y-5">
        <header className="space-y-1">
          <Breadcrumb
            items={orgBreadcrumb({ orgSlug: org.handle, pageLabel: "Search" })}
            className="mb-1"
          />
          <h1 className="text-xl font-semibold">Search across {org.handle}</h1>
        </header>

        <Form method="get" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={`Search across this org's Docos…`}
            className="w-full rounded-md border border-border bg-input px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary"
          />
          <button
            type="submit"
            className="rounded-md border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted"
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
                          to={`/${h.docoHandle}/${h.entity_type}/${h.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          <span aria-hidden className="mr-1.5">
                            <NeuronTypeIcon entityType={h.entity_type} />
                          </span>
                          {h.summary || h.id}
                        </Link>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                          {h.vector_score.toFixed(3)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <NodeTypeBadge entityType={h.entity_type}>
                          {nodeTypePlural(h.entity_type)}
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
      </main>
    </div>
  );
}
