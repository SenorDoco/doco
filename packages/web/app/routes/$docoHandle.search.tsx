import { withClient } from "@doco/db";
import type { ReactNode } from "react";
// Per-Doco search — vector-only ranker (ADR-052, supersedes ADR-030)
// + left-sidebar filters for lifecycle / node type.
//
// One provider call embeds keyword searches; filters resolve to a
// candidate id set BEFORE cosine so pagination always slices matching
// entities. With explicit filters and no keyword, this page lists the
// filtered nodes directly. Filter state lives in URL query params.
import { Form, Link, useSearchParams } from "react-router";
import { LifecycleBadge, NodeTypeBadge } from "~/components/badge";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { SiteHeader } from "~/components/site-header";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { loadHostConfig } from "~/lib/host.server";
import { lifecycleColor, nodeTypePlural } from "~/lib/neuron-colors";
import {
  type FilterFacets,
  type SearchFilters,
  computeFilterFacets,
  parseSearchFilters,
} from "~/lib/search-filters.server";
import type { SearchHit } from "~/lib/search.server";
import { loadFilteredSearchHits, rankSearchEmbeddings } from "~/lib/search.server";
import { getCurrentPrincipal } from "~/lib/session.server";

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

const SEARCH_PAGE_SIZE = 25;
const FILTER_PARAM_NAMES = ["lifecycle", "entity_type"] as const;

function hasExplicitSearchFilter(params: URLSearchParams): boolean {
  return FILTER_PARAM_NAMES.some((name) => params.has(name));
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
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const me = await getCurrentPrincipal(request);
  const host = await loadHostConfig();

  return withClient(async (c) => {
    let facets: FilterFacets = await computeFilterFacets(c, ctx.meta.docoId);
    const filters: SearchFilters = parseSearchFilters(url.searchParams, facets);

    if (!q) {
      const allHits = hasExplicitSearchFilter(url.searchParams)
        ? await loadFilteredSearchHits(c, ctx.meta.docoId, filters)
        : [];
      if (hasExplicitSearchFilter(url.searchParams)) {
        facets = withHitDerivedCounts(facets, allHits);
      }
      const pagination = paginationState(url.searchParams, allHits.length);
      return {
        q,
        hits: paginateHits(allHits, pagination),
        warning: null as string | null,
        ownerSlug,
        docoSlug,
        handle,
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
        hits: [] as SearchHit[],
        warning: "Vector search unavailable: no embedding provider configured (OPENAI_API_KEY).",
        ownerSlug,
        docoSlug,
        handle,
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
          hits: [] as SearchHit[],
          warning: "Vector search unavailable: provider returned empty embedding.",
          ownerSlug,
          docoSlug,
          handle,
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
        hits: [] as SearchHit[],
        warning: `Vector search unavailable: ${(e as Error).message}`,
        ownerSlug,
        docoSlug,
        handle,
        host,
        me,
        filters,
        facets,
        pagination: emptyPagination,
      };
    }

    const ranked = await rankSearchEmbeddings(c, ctx.meta.docoId, queryEmbedding, filters);
    if (ranked.hits.length === 0) {
      return {
        q,
        hits: [] as SearchHit[],
        warning:
          ranked.candidateIds === null
            ? "No embeddings in this Doco yet — reindex first."
            : "No entities match the active filters.",
        ownerSlug,
        docoSlug,
        handle,
        host,
        me,
        filters,
        facets,
        pagination: emptyPagination,
      };
    }

    const allHits = ranked.hits;
    facets = withHitDerivedCounts(facets, allHits);
    const pagination = paginationState(url.searchParams, allHits.length);

    return {
      q,
      hits: paginateHits(allHits, pagination),
      warning: null,
      ownerSlug,
      docoSlug,
      handle,
      host,
      me,
      filters,
      facets,
      pagination,
    };
  });
}

function withHitDerivedCounts(facets: FilterFacets, hits: SearchHit[]): FilterFacets {
  const lifecycleCounts = new Map<string, number>();
  const nodeTypeCounts = new Map<string, number>();
  for (const h of hits) {
    const lc = h.lifecycle ?? "active";
    lifecycleCounts.set(lc, (lifecycleCounts.get(lc) ?? 0) + 1);
    nodeTypeCounts.set(h.entity_type, (nodeTypeCounts.get(h.entity_type) ?? 0) + 1);
  }

  return {
    lifecycle: facets.lifecycle.map((f) => ({
      value: f.value,
      count: lifecycleCounts.get(f.value) ?? 0,
      updatedAt: f.updatedAt,
    })),
    entityType: facets.entityType.map((f) => ({
      value: f.value,
      count: nodeTypeCounts.get(f.value) ?? 0,
      updatedAt: f.updatedAt,
    })),
  };
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `Search · ${params.docoHandle ?? params.docoId ?? ""}` }];
}

export default function SearchInDoco({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { q, hits, warning, ownerSlug, docoSlug, handle, host, me, filters, facets, pagination } =
    loaderData;
  const [sp] = useSearchParams();
  const activeQ = sp.get("q") ?? q;
  const hasFilters = hasExplicitSearchFilter(sp);
  const preservedSearchParams = Array.from(sp.entries()).filter(
    ([key]) => key !== "q" && key !== "page",
  );

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Search" })} />
        <section className="space-y-4">
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
              />
              {preservedSearchParams.map(([key, value]) => (
                <input key={`${key}-${value}`} type="hidden" name={key} value={value} />
              ))}
            </div>
          </Form>
          <div className="space-y-4">
            <FacetGroup
              label="Types"
              name="entity_type"
              searchParams={sp}
              options={facets.entityType.map((f) => ({
                value: f.value,
                label: nodeTypePlural(f.value),
                count: f.count,
                icon: <NeuronTypeIcon entityType={f.value} />,
              }))}
              selected={new Set(filters.entityType ?? [])}
              wildcardActive={filters.entityType === null}
            />
            <FacetGroup
              label="Life cycles"
              name="lifecycle"
              searchParams={sp}
              options={facets.lifecycle.map((f) => ({
                value: f.value,
                label: f.value,
                count: f.count,
                color: lifecycleColor(f.value),
              }))}
              selected={new Set(filters.lifecycle ?? [])}
              wildcardActive={filters.lifecycle === null}
            />
          </div>
        </section>

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
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    <NodeTypeBadge entityType={hit.entity_type} />
                    <Link
                      to={`/${handle}/${hit.entity_type}/${hit.id}`}
                      className="break-all font-mono text-xs text-primary hover:underline"
                    >
                      {hit.id}
                    </Link>
                    {hit.lifecycle ? <LifecycleBadge lifecycle={hit.lifecycle} /> : null}
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
  options: {
    value: string;
    label: string;
    count: number;
    icon?: ReactNode;
    color?: string | null;
  }[];
  selected: Set<string>;
  wildcardActive: boolean;
}) {
  return (
    <section className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs text-muted-foreground">{label}</h2>
        <Link to={hrefForAll(searchParams, name)} className="text-xs text-primary hover:underline">
          All
        </Link>
      </div>
      {options.map((o) => {
        const isSelected = wildcardActive || selected.has(o.value);
        const color = o.color ?? null;
        return (
          <div key={o.value} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <Link
              to={hrefForToggle(searchParams, name, o.value, options, selected, wildcardActive)}
              className="flex min-w-0 items-center gap-2 text-xs hover:text-primary"
            >
              <span
                aria-hidden="true"
                className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none ${
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/70"
                }`}
                style={
                  color
                    ? {
                        borderColor: color,
                        backgroundColor: isSelected
                          ? color
                          : `color-mix(in oklch, ${color} 7%, white)`,
                        color: isSelected ? "white" : color,
                      }
                    : undefined
                }
              >
                {isSelected ? "✓" : ""}
              </span>
              {o.icon ? (
                <span aria-hidden className="shrink-0 font-sans text-[12px] leading-none">
                  {o.icon}
                </span>
              ) : null}
              <span className="truncate" style={color ? { color } : undefined}>
                {o.label}
              </span>
            </Link>
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              <span className="inline-block min-w-8 text-right tabular-nums">
                {isSelected ? o.count : ""}
              </span>{" "}
              <Link
                to={hrefForOnly(searchParams, name, o.value)}
                className="text-primary hover:underline"
              >
                (only)
              </Link>
            </span>
          </div>
        );
      })}
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
