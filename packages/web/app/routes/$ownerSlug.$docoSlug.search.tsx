import { cosineSimilarity, getAllEmbeddingsForDoco, withClient } from "@doco/db";
import { globalPageRank } from "@doco/index";
import type { PoolClient } from "pg";
// Per-Doco search — vector-only ranker (ADR-052, supersedes ADR-030)
// + left-sidebar filters for lifecycle / node type / scope.
//
// One provider call embeds keyword searches; filters resolve to a
// candidate id set BEFORE cosine so pagination always slices matching
// entities. With explicit filters and no keyword, this page lists the
// filtered nodes directly. Filter state lives in URL query params.
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
const SEARCH_PAGE_SIZE = 25;

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
  return hits;
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

interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  start: number;
  end: number;
}

function paginationState(params: URLSearchParams, total: number): PaginationState {
  const rawPage = Number.parseInt(params.get("page") ?? "", 10);
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const requestedPage = Number.isFinite(rawPage) ? rawPage : 1;
  const page = Math.max(1, Math.min(totalPages, requestedPage));
  const startIndex = (page - 1) * SEARCH_PAGE_SIZE;
  const end = Math.min(total, startIndex + SEARCH_PAGE_SIZE);
  return {
    page,
    pageSize: SEARCH_PAGE_SIZE,
    total,
    totalPages,
    start: total === 0 ? 0 : startIndex + 1,
    end,
  };
}

function paginateHits<T>(hits: T[], pagination: PaginationState): T[] {
  return hits.slice(pagination.start === 0 ? 0 : pagination.start - 1, pagination.end);
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
      const allHits = hasExplicitSearchFilter(url.searchParams)
        ? await loadFilteredHits(c, ctx.meta.docoId, filters)
        : [];
      if (hasExplicitSearchFilter(url.searchParams)) {
        facets = await withHitDerivedCounts(facets, c, ctx.meta.docoId, allHits);
      }
      const pagination = paginationState(url.searchParams, allHits.length);
      return {
        q,
        hits: paginateHits(allHits, pagination),
        warning: null as string | null,
        ownerSlug,
        docoSlug,
        host,
        me,
        filters,
        facets,
        pagination,
      };
    }

    const provider = getDocoEmbeddingProvider();
    const emptyPagination = paginationState(url.searchParams, 0);
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
        pagination: emptyPagination,
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
          pagination: emptyPagination,
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
        pagination: emptyPagination,
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
        pagination: emptyPagination,
      };
    }

    const scored = all.map((e) => ({
      entity_id: e.entity_id,
      score: cosineSimilarity(queryEmbedding, e.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    const scoreById = new Map(scored.map((t) => [t.entity_id, t.score]));
    const allIds = scored.map((t) => t.entity_id);

    const allHits = await hydrateHits(c, allIds, ctx.meta.docoId, scoreById);
    await attachGlobalPageRank(c, ctx.meta.docoId, allHits);
    allHits.sort((a, b) => (b.vector_score ?? 0) - (a.vector_score ?? 0));

    facets = await withHitDerivedCounts(facets, c, ctx.meta.docoId, allHits);
    const pagination = paginationState(url.searchParams, allHits.length);

    return {
      q,
      hits: paginateHits(allHits, pagination),
      warning: null,
      ownerSlug,
      docoSlug,
      host,
      me,
      filters,
      facets,
      pagination,
    };
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
  const { q, hits, warning, ownerSlug, docoSlug, host, me, filters, facets, pagination } =
    loaderData;
  const [sp] = useSearchParams();
  const activeQ = sp.get("q") ?? q;
  const hasFilters = hasExplicitSearchFilter(sp);
  const preservedSearchParams = Array.from(sp.entries()).filter(
    ([key]) => key !== "q" && key !== "page",
  );

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
              {preservedSearchParams.map(([key, value], index) => (
                <input key={`${key}-${value}-${index}`} type="hidden" name={key} value={value} />
              ))}
            </div>
          </Form>
          <div className="space-y-4">
            <FacetGroup
              label="Scopes"
              name="scope"
              searchParams={sp}
              options={facets.scope.map((f) => ({
                value: f.name,
                label: f.name,
                count: f.count,
              }))}
              selected={new Set(filters.scope ?? [])}
              wildcardActive={filters.scope === null}
            />
            <FacetGroup
              label="Types"
              name="node_type"
              searchParams={sp}
              options={facets.nodeType.map((f) => ({
                value: f.value,
                label: f.value,
                count: f.count,
              }))}
              selected={new Set(filters.nodeType ?? [])}
              wildcardActive={filters.nodeType === null}
            />
            <FacetGroup
              label="Life cycles"
              name="lifecycle"
              searchParams={sp}
              options={facets.lifecycle.map((f) => ({
                value: f.value,
                label: f.value,
                count: f.count,
              }))}
              selected={new Set(filters.lifecycle ?? [])}
              wildcardActive={filters.lifecycle === null}
            />
          </div>
        </aside>

        <section className="space-y-4">
          <ResultsSummary pagination={pagination} />
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
          <PaginationControls pagination={pagination} searchParams={sp} />
        </section>
      </main>
    </div>
  );
}

function FacetGroup({
  label,
  name,
  searchParams,
  options,
  selected,
  wildcardActive,
}: {
  label: string;
  name: string;
  searchParams: URLSearchParams;
  options: { value: string; label: string; count: number }[];
  selected: Set<string>;
  wildcardActive: boolean;
}) {
  return (
    <section className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs text-muted-foreground">{label}</h2>
        <Link
          to={hrefForAll(searchParams, name)}
          className="text-xs text-primary hover:underline"
        >
          All
        </Link>
      </div>
      {options.map((o) => (
        <div key={o.value} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <Link
            to={hrefForToggle(searchParams, name, o.value, options, selected, wildcardActive)}
            className="flex min-w-0 items-center gap-2 text-xs hover:text-primary"
          >
            <span
              aria-hidden="true"
              className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none ${
                wildcardActive || selected.has(o.value)
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/70"
              }`}
            >
              {wildcardActive || selected.has(o.value) ? "✓" : ""}
            </span>
            <span className="truncate">{o.label}</span>
          </Link>
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {o.count}{" "}
            <Link
              to={hrefForOnly(searchParams, name, o.value)}
              className="text-primary hover:underline"
            >
              (only)
            </Link>
          </span>
        </div>
      ))}
    </section>
  );
}

function ResultsSummary({ pagination }: { pagination: PaginationState }) {
  const shown = pagination.end === 0 ? 0 : pagination.end - pagination.start + 1;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        Showing {shown} of {pagination.total} found
        {pagination.total > 0 ? ` (${pagination.start}-${pagination.end})` : ""}
      </span>
      {pagination.totalPages > 1 ? (
        <span>
          Page {pagination.page} of {pagination.totalPages}
        </span>
      ) : null}
    </div>
  );
}

function PaginationControls({
  pagination,
  searchParams,
}: {
  pagination: PaginationState;
  searchParams: URLSearchParams;
}) {
  if (pagination.totalPages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-3 text-xs" aria-label="Search results">
      {pagination.page > 1 ? (
        <Link
          to={hrefForPage(searchParams, pagination.page - 1)}
          className="text-primary hover:underline"
        >
          Previous
        </Link>
      ) : (
        <span className="text-muted-foreground">Previous</span>
      )}
      {pagination.page < pagination.totalPages ? (
        <Link
          to={hrefForPage(searchParams, pagination.page + 1)}
          className="text-primary hover:underline"
        >
          Next
        </Link>
      ) : (
        <span className="text-muted-foreground">Next</span>
      )}
    </nav>
  );
}

function hrefForAll(searchParams: URLSearchParams, name: string): string {
  const next = nextSearchParams(searchParams);
  next.delete(name);
  next.append(name, "*");
  return searchHref(next);
}

function hrefForOnly(searchParams: URLSearchParams, name: string, value: string): string {
  const next = nextSearchParams(searchParams);
  next.delete(name);
  next.append(name, value);
  return searchHref(next);
}

function hrefForToggle(
  searchParams: URLSearchParams,
  name: string,
  value: string,
  options: { value: string }[],
  selected: Set<string>,
  wildcardActive: boolean,
): string {
  const next = nextSearchParams(searchParams);
  next.delete(name);

  const optionValues = options.map((o) => o.value);
  const values = new Set(wildcardActive ? optionValues : Array.from(selected));
  if (values.has(value)) {
    if (values.size > 1) values.delete(value);
  } else {
    values.add(value);
  }

  for (const v of optionValues) {
    if (values.has(v)) next.append(name, v);
  }
  return searchHref(next);
}

function hrefForPage(searchParams: URLSearchParams, page: number): string {
  const next = new URLSearchParams(searchParams);
  if (page <= 1) next.delete("page");
  else next.set("page", String(page));
  return searchHref(next);
}

function nextSearchParams(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete("page");
  return next;
}

function searchHref(searchParams: URLSearchParams): string {
  const qs = searchParams.toString();
  return qs ? `?${qs}` : "?";
}
