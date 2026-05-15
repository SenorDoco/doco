import { cosineSimilarity, getAllEmbeddingsForDoco, withClient } from "@doco/db";
import { globalPageRank } from "@doco/index";
import type { PoolClient } from "pg";
// Per-Doco search — vector-only ranker (ADR-052, supersedes ADR-030)
// + left-sidebar filters for lifecycle / node type / scope.
//
// One provider call embeds keyword searches; filters resolve to a
// candidate id set BEFORE cosine so the top-N slice always returns up
// to N matching entities. With explicit filters and no keyword, this
// page lists the filtered nodes directly. Filter state lives in URL
// query params.
import { Form, Link, useSearchParams } from "react-router";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { loadHostConfig } from "~/lib/host";
import {
  type FilterFacets,
  type SearchFilters,
  computeFilterFacets,
  parseSearchFilters,
  resolveFilteredCandidates,
} from "~/lib/search-filters.server";
import { getCurrentPrincipal } from "~/lib/session";

function relativeTimeIso(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const deltaMs = Date.now() - t;
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Hit {
  id: string;
  node_type: string;
  summary: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  gpr: number;
  vector_score: number | null;
}

/**
 * Per-node-type hydration. PG plural names; principal/organization have
 * different "name-ish" columns.
 */
interface TypeSpec {
  table: string;
  nodeType: string;
  selectExtra: string;
  /** Build the Hit shape from a row. */
  toHit(row: Record<string, unknown>, vectorScore: number | null): Omit<Hit, "gpr">;
  /** Doco-scoped or host-level? */
  hostLevel: boolean;
}

const TYPE_SPECS: TypeSpec[] = [
  {
    table: "decisions",
    nodeType: "decision",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "decision",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "intents",
    nodeType: "intent",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "intent",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "rules",
    nodeType: "rule",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "rule",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "actions",
    nodeType: "action",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "action",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "reasoning",
    nodeType: "reasoning",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "reasoning",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "reference_entities",
    nodeType: "reference",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "reference",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "scopes",
    nodeType: "scope",
    selectExtra: "name, summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "scope",
      summary: (r.summary as string) ?? "",
      name: (r.name as string) ?? null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "evals",
    nodeType: "eval",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "eval",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "ideas",
    nodeType: "idea",
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "idea",
      summary: (r.summary as string) ?? "",
      name: null,
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "principals",
    nodeType: "principal",
    selectExtra: "username, display_name, created_at",
    hostLevel: true,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "principal",
      summary: (r.display_name as string) ?? "",
      name: (r.username as string) ?? null,
      lifecycle: null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
  {
    table: "organizations",
    nodeType: "organization",
    selectExtra: "slug, name, created_at",
    hostLevel: true,
    toHit: (r, s) => ({
      id: String(r.id),
      node_type: "organization",
      summary: (r.name as string) ?? "",
      name: (r.slug as string) ?? null,
      lifecycle: null,
      created_at: (r.created_at as string) ?? null,
      vector_score: s,
    }),
  },
];

const FILTER_PARAM_NAMES = ["lifecycle", "node_type", "scope"] as const;

function hasExplicitSearchFilter(params: URLSearchParams): boolean {
  return FILTER_PARAM_NAMES.some((name) => params.has(name));
}

async function loadFilteredHits(
  c: PoolClient,
  docoId: string,
  filters: SearchFilters,
): Promise<Hit[]> {
  const candidateIds = await resolveFilteredCandidates(c, docoId, filters);
  if (candidateIds !== null && candidateIds.size === 0) return [];

  const ids =
    candidateIds === null ? await loadAllDocoEntityIds(c, docoId) : Array.from(candidateIds);
  const hits = await hydrateHits(c, ids, docoId, null);
  await attachGlobalPageRank(c, docoId, hits);
  hits.sort((a, b) => {
    const byCreated = createdTime(b.created_at) - createdTime(a.created_at);
    if (byCreated !== 0) return byCreated;
    const byGpr = b.gpr - a.gpr;
    if (byGpr !== 0) return byGpr;
    return a.id.localeCompare(b.id);
  });
  return hits.slice(0, filters.limit);
}

async function loadAllDocoEntityIds(c: PoolClient, docoId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of TYPE_SPECS) {
    if (spec.hostLevel) continue;
    const rows = (
      await c.query<{ id: string }>(`SELECT id FROM ${spec.table} WHERE doco_id = $1`, [docoId])
    ).rows;
    for (const row of rows) ids.push(row.id);
  }
  return ids;
}

async function hydrateHits(
  c: PoolClient,
  ids: string[],
  docoId: string,
  scoreById: Map<string, number> | null,
): Promise<Hit[]> {
  if (ids.length === 0) return [];
  const hits: Hit[] = [];
  for (const spec of TYPE_SPECS) {
    const sql = spec.hostLevel
      ? `SELECT id, ${spec.selectExtra} FROM ${spec.table} WHERE id = ANY($1::text[])`
      : `SELECT id, ${spec.selectExtra} FROM ${spec.table} WHERE id = ANY($1::text[]) AND doco_id = $2`;
    const params = spec.hostLevel ? [ids] : [ids, docoId];
    const rows = (await c.query(sql, params)).rows;
    for (const row of rows) {
      const rawScore = scoreById?.get(String(row.id));
      const score = typeof rawScore === "number" ? Math.round(rawScore * 10000) / 10000 : null;
      const hit = spec.toHit(row as Record<string, unknown>, score);
      hits.push({ ...hit, gpr: 0 });
    }
  }
  return hits;
}

async function attachGlobalPageRank(c: PoolClient, docoId: string, hits: Hit[]): Promise<void> {
  if (hits.length === 0) return;
  const edgeRows = (
    await c.query<{ from_id: string; to_id: string; edge_type: string; attribution: string }>(
      `SELECT from_id, to_id, edge_type, attribution FROM edges WHERE doco_id = $1`,
      [docoId],
    )
  ).rows;
  const gpr = globalPageRank(
    edgeRows.map((e) => ({
      from: e.from_id,
      to: e.to_id,
      edge_type: e.edge_type,
      attribution: e.attribution as "explicit" | "doco-auto",
    })),
    { alpha: 0.85 },
  );
  const gprById = new Map<string, number>();
  for (const p of gpr) gprById.set(p.id, p.score);
  for (const h of hits) h.gpr = gprById.get(h.id) ?? 0;
}

function createdTime(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const ctx = await loadDocoForRead(request, ownerSlug, docoSlug);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const me = await getCurrentPrincipal(request);
  const host = await loadHostConfig();

  return withClient(async (c) => {
    let facets: FilterFacets = await computeFilterFacets(c, ctx.meta.docoId);
    const filters: SearchFilters = parseSearchFilters(url.searchParams, facets);

    if (!q) {
      const hits = hasExplicitSearchFilter(url.searchParams)
        ? await loadFilteredHits(c, ctx.meta.docoId, filters)
        : [];
      if (hits.length > 0) {
        facets = await withHitDerivedCounts(facets, c, ctx.meta.docoId, hits);
      }
      return {
        q,
        hits,
        warning: null as string | null,
        ownerSlug,
        docoSlug,
        host,
        me,
        filters,
        facets,
      };
    }

    const provider = getDocoEmbeddingProvider();
    if (!provider) {
      return {
        q,
        hits: [] as Hit[],
        warning: "Vector search unavailable: no embedding provider configured (OPENAI_API_KEY).",
        ownerSlug,
        docoSlug,
        host,
        me,
        filters,
        facets,
      };
    }

    let queryEmbedding: Float32Array;
    try {
      const [v] = await provider.embed([q]);
      if (!v || v.length === 0) {
        return {
          q,
          hits: [] as Hit[],
          warning: "Vector search unavailable: provider returned empty embedding.",
          ownerSlug,
          docoSlug,
          host,
          me,
          filters,
          facets,
        };
      }
      queryEmbedding = v;
    } catch (e) {
      return {
        q,
        hits: [] as Hit[],
        warning: `Vector search unavailable: ${(e as Error).message}`,
        ownerSlug,
        docoSlug,
        host,
        me,
        filters,
        facets,
      };
    }

    const candidateIds = await resolveFilteredCandidates(c, ctx.meta.docoId, filters);
    const all = (await getAllEmbeddingsForDoco(ctx.meta.docoId)).filter(
      (e) => candidateIds === null || candidateIds.has(e.entity_id),
    );
    if (all.length === 0) {
      return {
        q,
        hits: [] as Hit[],
        warning:
          candidateIds === null
            ? "No embeddings in this Doco yet — reindex first."
            : "No entities match the active filters.",
        ownerSlug,
        docoSlug,
        host,
        me,
        filters,
        facets,
      };
    }

    const scored = all.map((e) => ({
      entity_id: e.entity_id,
      score: cosineSimilarity(queryEmbedding, e.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, filters.limit);
    const topById = new Map(top.map((t) => [t.entity_id, t.score]));
    const topIds = top.map((t) => t.entity_id);

    const hits = await hydrateHits(c, topIds, ctx.meta.docoId, topById);
    await attachGlobalPageRank(c, ctx.meta.docoId, hits);
    hits.sort((a, b) => (b.vector_score ?? 0) - (a.vector_score ?? 0));

    facets = await withHitDerivedCounts(facets, c, ctx.meta.docoId, hits);

    return { q, hits, warning: null, ownerSlug, docoSlug, host, me, filters, facets };
  });
}

async function withHitDerivedCounts(
  facets: FilterFacets,
  c: PoolClient,
  docoId: string,
  hits: Hit[],
): Promise<FilterFacets> {
  const lifecycleCounts = new Map<string, number>();
  const nodeTypeCounts = new Map<string, number>();
  for (const h of hits) {
    const lc = h.lifecycle ?? "active";
    lifecycleCounts.set(lc, (lifecycleCounts.get(lc) ?? 0) + 1);
    nodeTypeCounts.set(h.node_type, (nodeTypeCounts.get(h.node_type) ?? 0) + 1);
  }

  const scopeCounts = new Map<string, number>();
  if (hits.length > 0) {
    const rows = (
      await c.query<{ name: string; n: string }>(
        `SELECT s.name AS name, COUNT(*)::text AS n
           FROM edges e
           INNER JOIN scopes s ON s.id = e.to_id
          WHERE e.edge_type = 'in_scope_of'
            AND e.doco_id = $1
            AND e.from_id = ANY($2::text[])
          GROUP BY s.name`,
        [docoId, hits.map((h) => h.id)],
      )
    ).rows;
    for (const r of rows) scopeCounts.set(r.name, Number(r.n));
  }

  return {
    lifecycle: facets.lifecycle.map((f) => ({
      value: f.value,
      count: lifecycleCounts.get(f.value) ?? 0,
    })),
    nodeType: facets.nodeType.map((f) => ({
      value: f.value,
      count: nodeTypeCounts.get(f.value) ?? 0,
    })),
    scope: facets.scope.map((f) => ({
      name: f.name,
      count: scopeCounts.get(f.name) ?? 0,
    })),
  };
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Search · ${params.ownerSlug}/${params.docoSlug}` }];
}

export default function SearchInDoco({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { q, hits, warning, ownerSlug, docoSlug, host, me, filters, facets } = loaderData;
  const [sp] = useSearchParams();
  const activeQ = sp.get("q") ?? q;
  const hasFilters = hasExplicitSearchFilter(sp);

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 grid grid-cols-1 md:grid-cols-[18rem_1fr] gap-6">
        <aside className="space-y-4">
          <Form method="get" className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground" htmlFor="q">
                Search
              </label>
              <input
                id="q"
                name="q"
                defaultValue={activeQ}
                placeholder="Find anything…"
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                autoFocus
              />
            </div>
            <FacetGroup
              label="Lifecycle"
              name="lifecycle"
              options={facets.lifecycle.map((f) => ({
                value: f.value,
                label: `${f.value} (${f.count})`,
              }))}
              selected={new Set(filters.lifecycle ?? [])}
              wildcardActive={filters.lifecycle === null}
            />
            <FacetGroup
              label="Type"
              name="node_type"
              options={facets.nodeType.map((f) => ({
                value: f.value,
                label: `${f.value} (${f.count})`,
              }))}
              selected={new Set(filters.nodeType ?? [])}
              wildcardActive={filters.nodeType === null}
            />
            <FacetGroup
              label="Scope"
              name="scope"
              options={facets.scope.map((f) => ({
                value: f.name,
                label: `${f.name} (${f.count})`,
              }))}
              selected={new Set(filters.scope ?? [])}
              wildcardActive={filters.scope === null}
            />
            <button type="submit" className="rounded-md border px-3 py-1 text-sm">
              Apply
            </button>
          </Form>
        </aside>

        <section className="space-y-4">
          {warning ? (
            <Card>
              <CardContent className="pt-4 text-sm text-muted-foreground">{warning}</CardContent>
            </Card>
          ) : null}
          {hits.length === 0 && !warning ? (
            <Card>
              <CardContent className="pt-4 text-sm text-muted-foreground">
                {activeQ
                  ? "No hits."
                  : hasFilters
                    ? "No nodes match these filters."
                    : "Type a query to search."}
              </CardContent>
            </Card>
          ) : null}
          {hits.map((hit) => {
            const vectorScore = hit.vector_score;
            return (
              <Card key={hit.id}>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge>{hit.node_type}</Badge>
                    <Link
                      to={`/${ownerSlug}/${docoSlug}/${hit.node_type}/${hit.id}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {hit.id}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {vectorScore === null ? "" : `cosine ${vectorScore.toFixed(4)} · `}
                      gpr {hit.gpr.toFixed(4)} · {relativeTimeIso(hit.created_at)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">{hit.summary || hit.name || hit.id}</p>
                </CardContent>
              </Card>
            );
          })}
        </section>
      </main>
    </div>
  );
}

function FacetGroup({
  label,
  name,
  options,
  selected,
  wildcardActive,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  wildcardActive: boolean;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs text-muted-foreground">{label}</legend>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" name={name} value="*" defaultChecked={wildcardActive} />
        <span>any</span>
      </label>
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            name={name}
            value={o.value}
            defaultChecked={selected.has(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
