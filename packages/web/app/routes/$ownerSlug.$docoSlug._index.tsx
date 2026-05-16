import { withClient } from "@doco/db";
// Per-Doco home — bare title up top, then the search input, then a
// two-column body: Nodes on the left, "Activity" heatmap above the
// "Latest activity" feed on the right.
//
// The feed renders one line per recent audit event in the same family as
// agent footer lines: `<op-icon> <Type> <verb>: <summary>`. Lifecycle
// transitions include their old → new value so state changes show up in
// the feed instead of disappearing behind the entity's original created_at.
//
// Live feed (ADR-089): re-fetch every 5s so new entities show up
// without a manual refresh. React Router 7's useRevalidator re-runs the
// loader. We only poll when the tab is visible to avoid burning cycles
// on idle tabs.
import { useEffect, useState } from "react";
import { Form, Link, useRevalidator } from "react-router";
import { parse as parseYaml } from "yaml";
import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NodesOverviewCard, type NodesOverviewSection } from "~/components/nodes-overview-card";
import { SiteHeader } from "~/components/site-header";
import { docoPath } from "~/lib/db.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { nodeTypeColor } from "~/lib/node-colors";
import { listScopeDetails } from "~/lib/scope-helpers.server";
import { computeFilterFacets } from "~/lib/search-filters.server";

const FEED_LIMIT = 30;
const HEATMAP_WEEKS = 52;

interface FeedItem extends ActivityFeedLineItem {
  event_id: string;
}

const NODE_TYPE_LABELS: Record<string, string> = {
  decision: "Decisions",
  action: "Actions",
  intent: "Intents",
  rule: "Rules",
  scope: "Scopes",
  eval: "Evals",
  reference: "References",
  idea: "Ideas",
};

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}s`;
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
  const me = ctx.me;
  const dir = docoPath(ownerSlug, docoSlug);
  const scopeDetails = await listScopeDetails(dir);
  const scopeById = new Map(scopeDetails.map((s) => [s.id, s]));
  return withClient(async (c) => {
    type AuditFeedRow = {
      event_id: string;
      at: Date | string;
      entity_type: string;
      entity_id: string;
      op: string;
      before_json: Record<string, unknown> | null;
      after_json: Record<string, unknown> | null;
    };
    const rawItems = (
      await c.query<AuditFeedRow>(
        `SELECT event_id, at, entity_type, entity_id, op, before_json, after_json
           FROM audit_events
          WHERE doco_id = $1
          ORDER BY at DESC
          LIMIT $2`,
        [ctx.meta.docoId, FEED_LIMIT],
      )
    ).rows;

    const entityIds = Array.from(new Set(rawItems.map((r) => r.entity_id)));
    const entityById = new Map<string, { summary: string | null; lifecycle: string | null }>();
    if (entityIds.length > 0) {
      const summaryRows = await c.query<{
        id: string;
        summary: string | null;
        lifecycle: string | null;
      }>(
        `SELECT id, summary, lifecycle FROM decisions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM intents WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM ideas WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM rules WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM actions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM logs WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM evals WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM states WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, COALESCE(summary, name) AS summary, lifecycle FROM scopes WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary, lifecycle FROM reference_entities WHERE doco_id = $1 AND id = ANY($2::text[])`,
        [ctx.meta.docoId, entityIds],
      );
      for (const row of summaryRows.rows) {
        entityById.set(row.id, { summary: row.summary, lifecycle: row.lifecycle });
      }
    }

    let scopeEdges: { from_id: string; to_id: string }[] = [];
    if (rawItems.length > 0) {
      scopeEdges = (
        await c.query<{ from_id: string; to_id: string }>(
          `SELECT from_id, to_id FROM edges
            WHERE edge_type = 'in_scope_of'
              AND doco_id = $1
              AND from_id = ANY($2::text[])`,
          [ctx.meta.docoId, entityIds],
        )
      ).rows;
    }
    const scopeIdsByItem = new Map<string, string[]>();
    for (const e of scopeEdges) {
      const arr = scopeIdsByItem.get(e.from_id) ?? [];
      arr.push(e.to_id);
      scopeIdsByItem.set(e.from_id, arr);
    }
    const items: FeedItem[] = rawItems.map((it) => {
      const entity = entityById.get(it.entity_id);
      const sids = scopeIdsByItem.get(it.entity_id) ?? [];
      const scopes = sids
        .map((id) => scopeById.get(id))
        .filter((s): s is NonNullable<typeof s> => s != null)
        .map((s) => (s.icon ? { name: s.name, icon: s.icon } : { name: s.name }));
      return {
        event_id: it.event_id,
        id: it.entity_id,
        node_type: it.entity_type,
        summary:
          entity?.summary ??
          stringField(it.after_json, "summary") ??
          stringField(it.before_json, "summary"),
        lifecycle: entity?.lifecycle ?? null,
        at: it.at instanceof Date ? it.at.toISOString() : new Date(String(it.at)).toISOString(),
        op: it.op,
        before: it.before_json,
        after: it.after_json,
        scopes,
      };
    });

    const facets = await computeFilterFacets(c, ctx.meta.docoId);
    const totalNodes = facets.nodeType.reduce((sum, t) => sum + t.count, 0);

    const since = new Date();
    since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
    const sinceIso = since.toISOString();
    const activityRows = (
      await c.query<{ day: string; n: string }>(
        `SELECT day, COUNT(*)::text AS n FROM (
           SELECT to_char(created_at, 'YYYY-MM-DD') AS day FROM decisions WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM intents WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM ideas WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM rules WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM actions WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM logs WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM evals WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM scopes WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM reference_entities WHERE doco_id = $1
         ) t WHERE day >= $2
         GROUP BY day`,
        [ctx.meta.docoId, sinceIso.slice(0, 10)],
      )
    ).rows;
    const byDay: Record<string, number> = {};
    for (const r of activityRows) byDay[r.day] = Number(r.n);

    return {
      items,
      facets,
      totalNodes,
      byDay,
      ownerSlug,
      docoSlug,
      docoId: ctx.meta.docoId,
      host: await loadHostConfig(),
      me,
    };
  });
}

function allNodesSearchPath(ownerSlug: string, docoSlug: string): string {
  const params = new URLSearchParams();
  params.set("node_type", "*");
  params.set("lifecycle", "*");
  params.set("scope", "*");
  params.set("limit", "500");
  return `/${ownerSlug}/${docoSlug}/search?${params.toString()}`;
}

function nodeTypeSearchPath(ownerSlug: string, docoSlug: string, nodeType: string): string {
  const params = new URLSearchParams();
  params.set("node_type", nodeType);
  params.set("lifecycle", "*");
  params.set("scope", "*");
  params.set("limit", "500");
  return `/${ownerSlug}/${docoSlug}/search?${params.toString()}`;
}

function scopeDetailPath(ownerSlug: string, docoSlug: string, scopeId: string): string {
  return `/${ownerSlug}/${docoSlug}/scopes/${scopeId}`;
}

function lifecycleSearchPath(ownerSlug: string, docoSlug: string, lifecycle: string): string {
  const params = new URLSearchParams();
  params.set("lifecycle", lifecycle);
  params.set("node_type", "*");
  params.set("scope", "*");
  params.set("limit", "500");
  return `/${ownerSlug}/${docoSlug}/search?${params.toString()}`;
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export default function DocoHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { items, facets, totalNodes, byDay, ownerSlug, docoSlug, docoId, host, me } = loaderData;

  // Live feed polling (ADR-089).
  const revalidator = useRevalidator();
  useEffect(() => {
    let tick: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (tick !== null) return;
      tick = setInterval(() => {
        if (document.visibilityState === "visible" && revalidator.state === "idle") {
          revalidator.revalidate();
        }
      }, 5000);
    };
    const stop = () => {
      if (tick !== null) {
        clearInterval(tick);
        tick = null;
      }
    };
    start();
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revalidator]);

  const allSearchHref = allNodesSearchPath(ownerSlug, docoSlug);

  const sections: NodesOverviewSection[] = [
    {
      title: "Scopes",
      items: facets.scope.map((s) => ({
        key: `scope-${s.name}`,
        href: scopeDetailPath(ownerSlug, docoSlug, s.id),
        label: s.name,
        icon: s.icon ?? undefined,
        count: s.count,
        ariaLabel: `Open scope ${s.name}`,
      })),
    },
    {
      title: "Node types",
      items: facets.nodeType.map((t) => ({
        key: `type-${t.value}`,
        href: nodeTypeSearchPath(ownerSlug, docoSlug, t.value),
        label: nodeTypeLabel(t.value),
        count: t.count,
        ariaLabel: `Search ${t.count} ${nodeTypeLabel(t.value).toLowerCase()}`,
        color: nodeTypeColor(t.value),
      })),
    },
    {
      title: "Lifecycle",
      items: facets.lifecycle.map((l) => ({
        key: `lifecycle-${l.value}`,
        href: lifecycleSearchPath(ownerSlug, docoSlug, l.value),
        label: l.value,
        count: l.count,
        ariaLabel: `Search ${l.count} nodes in lifecycle ${l.value}`,
      })),
    },
  ];

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-5">
        {/* Bare title — no card wrapper. */}
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            <Link to={allSearchHref} className="hover:text-primary">
              {ownerSlug}/{docoSlug}
            </Link>
          </h1>
          <p className="font-mono text-sm text-muted-foreground">{docoId}</p>
        </div>

        <div className="grid grid-cols-1 gap-5 min-[840px]:grid-cols-12">
          {/* Left: node counts. */}
          <aside className="min-[840px]:col-span-6">
            <NodesOverviewCard
              sections={sections}
              search={
                <SearchBoxWithHistory
                  ownerSlug={ownerSlug}
                  docoSlug={docoSlug}
                  placeholder={
                    totalNodes > 0
                      ? `Search ${totalNodes} node${totalNodes === 1 ? "" : "s"}…`
                      : "Search nodes…"
                  }
                />
              }
              empty={
                <p className="text-xs italic text-muted-foreground">This Doco has no nodes yet.</p>
              }
            />
          </aside>

          {/* Right: activity heatmap above the real-time feed. */}
          <section className="min-[840px]:col-span-6 space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Latest activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {items.length === 0 ? (
                  <div className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
                    No recorded activity yet. Create a scope in{" "}
                    <Link
                      to={`/${ownerSlug}/${docoSlug}/scopes/new`}
                      className="text-primary hover:underline"
                    >
                      scopes/new
                    </Link>{" "}
                    or capture a node; this feed records UI, CLI, and API writes.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {items.map((it) => (
                      <ActivityFeedLine
                        key={it.event_id}
                        item={it}
                        ownerSlug={ownerSlug}
                        docoSlug={docoSlug}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      </main>
    </div>
  );
}

const RECENT_LIMIT = 8;

interface RecentSearch {
  q: string;
  ts: number;
}

function recentSearchesKey(ownerSlug: string, docoSlug: string): string {
  return `doco:recent-searches:${ownerSlug}/${docoSlug}`;
}

function loadRecent(ownerSlug: string, docoSlug: string): RecentSearch[] {
  try {
    const raw = localStorage.getItem(recentSearchesKey(ownerSlug, docoSlug));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentSearch =>
          r !== null &&
          typeof r === "object" &&
          typeof (r as RecentSearch).q === "string" &&
          typeof (r as RecentSearch).ts === "number",
      )
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function saveRecent(ownerSlug: string, docoSlug: string, q: string): void {
  const trimmed = q.trim();
  if (trimmed.length === 0) return;
  const existing = loadRecent(ownerSlug, docoSlug).filter((r) => r.q !== trimmed);
  const next = [{ q: trimmed, ts: Date.now() }, ...existing].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(recentSearchesKey(ownerSlug, docoSlug), JSON.stringify(next));
  } catch {
    // localStorage may be unavailable (private mode, quota) — non-fatal.
  }
}

function removeRecent(ownerSlug: string, docoSlug: string, q: string): RecentSearch[] {
  const next = loadRecent(ownerSlug, docoSlug).filter((r) => r.q !== q);
  try {
    localStorage.setItem(recentSearchesKey(ownerSlug, docoSlug), JSON.stringify(next));
  } catch {
    // non-fatal.
  }
  return next;
}

function clearAllRecent(ownerSlug: string, docoSlug: string): void {
  try {
    localStorage.removeItem(recentSearchesKey(ownerSlug, docoSlug));
  } catch {
    // non-fatal.
  }
}

function relativeTimeMs(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SearchBoxWithHistory({
  ownerSlug,
  docoSlug,
  placeholder,
}: {
  ownerSlug: string;
  docoSlug: string;
  placeholder: string;
}) {
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setRecent(loadRecent(ownerSlug, docoSlug));
  }, [ownerSlug, docoSlug]);

  const showDropdown = focused && query.trim().length === 0 && recent.length > 0;

  return (
    <Form
      method="get"
      action={`/${ownerSlug}/${docoSlug}/search`}
      className="flex gap-2"
      onSubmit={() => {
        saveRecent(ownerSlug, docoSlug, query);
      }}
    >
      <div className="relative flex-1">
        <input
          name="q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          className="w-full rounded-md border border-border bg-input px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary"
        />
        {showDropdown ? (
          <ul
            aria-label="Recent searches"
            className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-border bg-card text-sm text-card-foreground shadow-sm"
          >
            {recent.map((r) => (
              <li key={r.q} className="flex items-center hover:bg-muted">
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    saveRecent(ownerSlug, docoSlug, r.q);
                    window.location.href = `/${ownerSlug}/${docoSlug}/search?q=${encodeURIComponent(r.q)}`;
                  }}
                  className="flex flex-1 items-center justify-between gap-3 px-4 py-2 text-left"
                >
                  <span className="truncate">{r.q}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {relativeTimeMs(r.ts)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove "${r.q}" from recent searches`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setRecent(removeRecent(ownerSlug, docoSlug, r.q));
                  }}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-base leading-none text-muted-foreground hover:bg-input hover:text-foreground"
                >
                  <span aria-hidden>×</span>
                </button>
              </li>
            ))}
            <li className="border-t border-border">
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  clearAllRecent(ownerSlug, docoSlug);
                  setRecent([]);
                }}
                className="block w-full px-4 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Clear all
              </button>
            </li>
          </ul>
        ) : null}
      </div>
      <button
        type="submit"
        className="rounded-md border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted"
      >
        Search
      </button>
    </Form>
  );
}

function stringField(
  obj: Record<string, unknown> | null | undefined,
  field: string,
): string | null {
  const value = obj?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}
