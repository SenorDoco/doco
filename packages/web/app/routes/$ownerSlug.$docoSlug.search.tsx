// Per-Doco search — vector-only ranker (ADR-052, supersedes ADR-030)
// + left-sidebar filters for lifecycle / node type / scope (Decision
// "what-shape-do-the-search-filters-take-and-how-do-defaults").
//
// One provider call embeds the query; filters resolve to a candidate
// id set BEFORE cosine so the top-N slice always returns up to N
// matching entities. Filter state lives in URL query params — bookmarks
// and the back button just work.
import { Form, Link, useSearchParams } from "react-router";
import { cosineSimilarity, getAllEmbeddings, globalPageRank } from "@doco/index";
import { openDocoDb } from "~/lib/db.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import {
  computeFilterFacets,
  parseSearchFilters,
  resolveFilteredCandidates,
  type FilterFacets,
  type SearchFilters,
} from "~/lib/search-filters.server";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

/** Per-node-type schemas differ — probe each table's columns. */
function pickAvailableColumns(
  db: import("better-sqlite3").Database,
  table: string,
  wanted: string[],
): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const have = new Set(rows.map((r) => r.name));
  return wanted.filter((c) => have.has(c));
}

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
  vector_score: number;
}

const NODE_TYPES = [
  "decision",
  "intent",
  "rule",
  "action",
  "reasoning",
  "reference",
  "scope",
  "eval",
  "idea",
  "principal",
  "organization",
] as const;

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  await loadDocoForRead(request, ownerSlug, docoSlug); // 404 if private + non-member
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const me = await getCurrentPrincipal(request);
  const host = await loadHostConfig();

  // Facets need a DB even on empty-query / unauth-provider paths so the
  // sidebar checkbox lists render correctly. Facets also feed
  // parseSearchFilters so the lifecycle default adapts to the data.
  const db = openDocoDb(ownerSlug, docoSlug);
  let facets: FilterFacets;
  let filters: SearchFilters;
  try {
    facets = computeFilterFacets(db);
    filters = parseSearchFilters(url.searchParams, facets);

    if (!q) {
      return {
        q,
        hits: [] as Hit[],
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

    // Embed the query.
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

    // Resolve filter candidates BEFORE cosine.
    const candidateIds = resolveFilteredCandidates(db, filters);
    const all = getAllEmbeddings(db).filter(
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

    // Hydrate by checking each per-type table for the top-N ids.
    // Scope/eval/org have `name`, principal has `username`; everything
    // else shows its `summary` as the display handle.
    const hitsByType = new Map<string, Hit[]>();
    for (const nodeType of NODE_TYPES) {
      const cols = pickAvailableColumns(db, nodeType, [
        "id",
        "name",
        "username",
        "summary",
        "lifecycle",
        "created_at",
      ]);
      const placeholders = top.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT ${cols.join(", ")} FROM ${nodeType} WHERE id IN (${placeholders})`)
        .all(...top.map((t) => t.entity_id)) as {
        id: string;
        name?: string | null;
        username?: string | null;
        summary?: string | null;
        lifecycle?: string | null;
        created_at?: string | null;
      }[];
      if (rows.length === 0) continue;
      hitsByType.set(
        nodeType,
        rows.map((row) => ({
          id: row.id,
          node_type: nodeType,
          summary: row.summary ?? "",
          name: row.name ?? row.username ?? null,
          lifecycle: row.lifecycle ?? null,
          created_at: row.created_at ?? null,
          gpr: 0,
          vector_score: Math.round((topById.get(row.id) ?? 0) * 10000) / 10000,
        })),
      );
    }

    // Global PageRank — attach for display alongside cosine.
    const allEdges = db
      .prepare("SELECT from_id, to_id, edge_type, attribution FROM edges")
      .all() as { from_id: string; to_id: string; edge_type: string; attribution: string }[];
    const gpr = globalPageRank(
      allEdges.map((e) => ({
        from: e.from_id,
        to: e.to_id,
        edge_type: e.edge_type,
        attribution: e.attribution as "explicit" | "doco-auto",
      })),
      { alpha: 0.85 },
    );
    const gprById = new Map<string, number>();
    for (const p of gpr) gprById.set(p.id, p.score);

    const hits: Hit[] = [];
    for (const arr of hitsByType.values()) {
      for (const h of arr) {
        h.gpr = gprById.get(h.id) ?? 0;
        hits.push(h);
      }
    }
    hits.sort((a, b) => b.vector_score - a.vector_score);

    // Replace the sidebar's global facet counts with counts derived
    // from the actual search hits. The list of facet VALUES still comes
    // from computeFilterFacets (so unmatched values stay visible at 0),
    // but the number next to each value now reflects the current
    // results — not the global Doco count.
    facets = withHitDerivedCounts(facets, db, hits);

    return { q, hits, warning: null, ownerSlug, docoSlug, host, me, filters, facets };
  } finally {
    db.close();
  }
}

/**
 * Bucket the current displayed hits by each facet axis. Lifecycle and
 * node_type come straight off the hit objects; scope memberships are
 * looked up in one `WHERE from_id IN (...)` pass. Values that don't
 * appear in any hit show as 0 (the facet value list stays stable so
 * the sidebar always shows every option the user could re-enable).
 */
function withHitDerivedCounts(
  facets: FilterFacets,
  db: import("better-sqlite3").Database,
  hits: Hit[],
): FilterFacets {
  const lifecycleCounts = new Map<string, number>();
  const nodeTypeCounts = new Map<string, number>();
  for (const h of hits) {
    const lc = h.lifecycle ?? "active";
    lifecycleCounts.set(lc, (lifecycleCounts.get(lc) ?? 0) + 1);
    nodeTypeCounts.set(h.node_type, (nodeTypeCounts.get(h.node_type) ?? 0) + 1);
  }

  const scopeCounts = new Map<string, number>();
  if (hits.length > 0) {
    const placeholders = hits.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT s.name AS name, COUNT(*) AS n
         FROM edges e
         INNER JOIN scope s ON s.id = e.to_id
         WHERE e.edge_type = 'in_scope_of' AND e.from_id IN (${placeholders})
         GROUP BY s.name`,
      )
      .all(...hits.map((h) => h.id)) as { name: string; n: number }[];
    for (const r of rows) scopeCounts.set(r.name, r.n);
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

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  return [
    {
      title: data?.q
        ? `Search: ${data.q} · ${data.ownerSlug}/${data.docoSlug}`
        : `Search · ${data?.ownerSlug ?? ""}/${data?.docoSlug ?? ""}`,
    },
  ];
}

/**
 * Filter sidebar — three checkbox groups in this fixed vertical order:
 * Lifecycle (first, default = `active` only), Node type, Scope. Toggling
 * any box auto-submits the surrounding form so results refresh as the
 * user tunes the filter. The hidden `q` input keeps the query intact.
 *
 * Each row also carries an `(only)` link — clicking it sets that one
 * row's filter group to just that value, leaving the other two groups'
 * state untouched.
 */
function FilterSidebar({
  q,
  filters,
  facets,
}: {
  q: string;
  filters: SearchFilters;
  facets: FilterFacets;
}) {
  // URL semantics (after parseSearchFilters applies defaults):
  // - filters.lifecycle: null when URL has `lifecycle=*`; otherwise an
  //   explicit list (the omitted-default fills in "all except retired").
  // - filters.nodeType: null when URL has `node_type=*`; otherwise an
  //   explicit list (the omitted-default fills in every facet value, so
  //   every checkbox renders checked by default).
  // - filters.scope: same convention as node_type.
  //
  // `null` (wildcard) is rendered as "all checked" so the UI shows the
  // user every value is included.
  const lifecycleChecked = (v: string) =>
    filters.lifecycle === null ? true : filters.lifecycle.includes(v);
  const nodeTypeChecked = (v: string) =>
    filters.nodeType === null ? true : filters.nodeType.includes(v);
  const scopeChecked = (v: string) =>
    filters.scope === null ? true : filters.scope.includes(v);

  /**
   * Build the URL for the "(only)" link. `targetGroup` becomes just
   * `[value]`; the other two groups stay at their currently-applied
   * state. To keep URLs short, if a preserved group's filter equals
   * its full facet list (every value selected), we emit `name=*`
   * instead of listing each one. `null` (wildcard) is also `*`.
   */
  const buildOnlyUrl = (
    targetGroup: "lifecycle" | "node_type" | "scope",
    value: string,
  ): string => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);

    const appendGroup = (
      name: "lifecycle" | "node_type" | "scope",
      values: string[] | null,
      allValues: string[],
    ): void => {
      if (values === null || (values.length === allValues.length && allValues.every((v) => values.includes(v)))) {
        params.set(name, "*");
      } else {
        for (const v of values) params.append(name, v);
      }
    };

    const allLifecycle = facets.lifecycle.map((f) => f.value);
    const allNodeType = facets.nodeType.map((f) => f.value);
    const allScope = facets.scope.map((f) => f.name);

    if (targetGroup === "lifecycle") {
      params.append("lifecycle", value);
    } else {
      appendGroup("lifecycle", filters.lifecycle, allLifecycle);
    }

    if (targetGroup === "node_type") {
      params.append("node_type", value);
    } else {
      appendGroup("node_type", filters.nodeType, allNodeType);
    }

    if (targetGroup === "scope") {
      params.append("scope", value);
    } else {
      appendGroup("scope", filters.scope, allScope);
    }

    return `?${params.toString()}`;
  };

  // After a soft-navigation triggered by an (only) link or row text,
  // React reuses the existing checkbox DOM nodes — but `defaultChecked`
  // only applies on mount, so checkbox state stays frozen at whatever
  // the user last toggled. The key forces React to remount the form
  // (and its inputs) whenever the URL filter state changes, so
  // defaultChecked is re-applied from the new loaderData.
  const formKey = JSON.stringify({
    l: filters.lifecycle,
    n: filters.nodeType,
    s: filters.scope,
  });

  return (
    <aside className="md:w-56 md:shrink-0 space-y-4">
      <Form
        method="get"
        id="filter-form"
        key={formKey}
        // Auto-submit when any checkbox changes (still POST-less, so the
        // back button takes you to the previous filter state).
        onChange={(e) => (e.currentTarget as HTMLFormElement).submit()}
      >
        <input type="hidden" name="q" value={q} />

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Lifecycle
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pb-3 pt-0">
            {facets.lifecycle.length === 0 ? (
              <p className="text-[11px] italic text-muted-foreground">No data.</p>
            ) : (
              facets.lifecycle.map((f) => (
                <div
                  key={f.value}
                  className="flex items-center gap-2 text-xs text-foreground"
                >
                  <input
                    type="checkbox"
                    name="lifecycle"
                    value={f.value}
                    defaultChecked={lifecycleChecked(f.value)}
                    aria-label={`Include ${f.value} in lifecycle filter`}
                  />
                  <Link
                    to={buildOnlyUrl("lifecycle", f.value)}
                    className="flex-1 hover:text-primary hover:underline"
                  >
                    <span className={f.value === "active" ? "font-semibold" : ""}>
                      {f.value}
                    </span>
                  </Link>
                  <span className="text-[10px] text-muted-foreground">{f.count}</span>
                  <Link
                    to={buildOnlyUrl("lifecycle", f.value)}
                    className="text-[10px] text-muted-foreground hover:text-primary hover:underline"
                  >
                    (only)
                  </Link>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Type
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pb-3 pt-0">
            {facets.nodeType.map((f) => (
              <div
                key={f.value}
                className="flex items-center gap-2 text-xs text-foreground"
              >
                <input
                  type="checkbox"
                  name="node_type"
                  value={f.value}
                  defaultChecked={nodeTypeChecked(f.value)}
                  aria-label={`Include ${f.value} in type filter`}
                />
                <Link
                  to={buildOnlyUrl("node_type", f.value)}
                  className="flex-1 font-mono hover:text-primary hover:underline"
                >
                  {f.value}
                </Link>
                <span className="text-[10px] text-muted-foreground">{f.count}</span>
                <Link
                  to={buildOnlyUrl("node_type", f.value)}
                  className="text-[10px] text-muted-foreground hover:text-primary hover:underline"
                >
                  (only)
                </Link>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Scope
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pb-3 pt-0">
            {facets.scope.length === 0 ? (
              <p className="text-[11px] italic text-muted-foreground">No scopes.</p>
            ) : (
              facets.scope.map((f) => (
                <div
                  key={f.name}
                  className="flex items-center gap-2 text-xs text-foreground"
                >
                  <input
                    type="checkbox"
                    name="scope"
                    value={f.name}
                    defaultChecked={scopeChecked(f.name)}
                    aria-label={`Include ${f.name} in scope filter`}
                  />
                  <Link
                    to={buildOnlyUrl("scope", f.name)}
                    className="flex-1 font-mono hover:text-primary hover:underline"
                  >
                    {f.name}
                  </Link>
                  <span className="text-[10px] text-muted-foreground">{f.count}</span>
                  <Link
                    to={buildOnlyUrl("scope", f.name)}
                    className="text-[10px] text-muted-foreground hover:text-primary hover:underline"
                  >
                    (only)
                  </Link>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <div className="pt-3 text-[11px] text-muted-foreground">
          <Link
            to={`?q=${encodeURIComponent(q)}`}
            className="text-primary hover:underline"
          >
            Reset filters
          </Link>
        </div>
      </Form>
    </aside>
  );
}

export default function SearchInDoco({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const { ownerSlug, docoSlug, host, me, hits, warning, filters, facets } = loaderData;

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        {/* Search box stays full-width above the filter+results columns. */}
        <Form method="get" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={`Search ${ownerSlug}/${docoSlug}…`}
            className="flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
          {/* Carry the current filter state through the manual submit. */}
          {filters.lifecycle !== null
            ? filters.lifecycle.map((v) => (
                <input key={`lc-${v}`} type="hidden" name="lifecycle" value={v} />
              ))
            : null}
          {filters.nodeType !== null
            ? filters.nodeType.map((v) => (
                <input key={`nt-${v}`} type="hidden" name="node_type" value={v} />
              ))
            : null}
          {filters.scope !== null
            ? filters.scope.map((v) => (
                <input key={`sc-${v}`} type="hidden" name="scope" value={v} />
              ))
            : null}
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Search
          </button>
        </Form>

        <div className="flex flex-col gap-4 md:flex-row">
          <FilterSidebar q={q} filters={filters} facets={facets} />

          <section className="min-w-0 flex-1 space-y-4">
            {!loaderData.q ? (
              <Card>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground">
                    Vector search: each query is embedded and cosine-ranked against every node in
                    this Doco. Filters on the left narrow the candidate set; defaults hide
                    deprecated content.
                  </p>
                </CardContent>
              </Card>
            ) : warning ? (
              <Card>
                <CardContent className="pt-4">
                  <p className="text-xs text-destructive">{warning}</p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">
                    Results ({hits.length}
                    {hits.length === filters.limit ? `, capped at ${filters.limit}` : ""})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {hits.length === 0 ? (
                    <p className="px-4 py-3 text-xs italic text-muted-foreground">
                      No matches.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {hits.map((r) => {
                        // Title: scope/principal use their short handle;
                        // everything else uses the summary. URL always
                        // resolves by ULID id.
                        const titleIsName = r.name !== null;
                        const title = r.name ?? r.summary ?? r.id;
                        // Avoid duplicating the same text in the secondary
                        // paragraph when the title already IS the summary.
                        const showSecondary = titleIsName && r.summary;
                        return (
                          <li key={r.id}>
                            <Link
                              to={`/${ownerSlug}/${docoSlug}/${r.node_type}/${r.id}`}
                              className="block px-4 py-3 hover:bg-input/40"
                            >
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <Badge className="shrink-0">{r.node_type}</Badge>
                                <span
                                  className={
                                    titleIsName
                                      ? "min-w-0 break-all font-mono text-sm text-primary"
                                      : "min-w-0 text-sm text-primary"
                                  }
                                >
                                  {title}
                                </span>
                                {r.lifecycle ? (
                                  <Badge variant="primary" className="shrink-0">
                                    {r.lifecycle}
                                  </Badge>
                                ) : null}
                              </div>
                              {showSecondary ? (
                                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                  {r.summary}
                                </p>
                              ) : null}
                              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                                <span>cos {r.vector_score.toFixed(4)}</span>
                                <span aria-hidden="true" className="opacity-60">
                                  ·
                                </span>
                                <span>GPR {r.gpr.toFixed(4)}</span>
                                <span aria-hidden="true" className="opacity-60">
                                  ·
                                </span>
                                <span>{relativeTimeIso(r.created_at)}</span>
                              </div>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

