import { withClient } from "@doco/db";
// Per-Doco home — bare title up top, then the search input, then a
// two-column body: Nodes on the left, "Activity" heatmap above the
// "Latest activity" feed on the right.
//
// The feed renders one line per recently-added entity in the same shape
// agents emit via `renderOperationLines` in capture.server.ts:
// `[🔮 Doco] <icon> <scope1>, …: ✍️ <Type> added: <summary>`. The
// summary is the markdown-link target (the slug is not shown). Keep this
// in sync with renderOperationLines if the footer shape ever moves.
//
// Live feed (ADR-089): re-fetch every 5s so new entities show up
// without a manual refresh. React Router 7's useRevalidator re-runs the
// loader. We only poll when the tab is visible to avoid burning cycles
// on idle tabs.
import { useEffect, useState } from "react";
import { Form, Link, useRevalidator } from "react-router";
import { parse as parseYaml } from "yaml";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Badge, NodeTypeBadge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import {
  NodesOverviewCard,
  type NodesOverviewSection,
} from "~/components/nodes-overview-card";
import { SiteHeader } from "~/components/site-header";
import { docoPath } from "~/lib/db.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { nodeTypeColor } from "~/lib/node-colors";
import { listScopeDetails } from "~/lib/scope-helpers.server";
import { computeFilterFacets } from "~/lib/search-filters.server";

const FEED_LIMIT = 30;
const HEATMAP_WEEKS = 26;

interface FeedItem {
  id: string;
  node_type: string;
  summary: string;
  created_at: string;
  title: string | null;
  /** Scope's readable handle. Other types leave it null. */
  name: string | null;
  scopes: { name: string; icon?: string }[];
}

const NODE_TYPE_LABELS: Record<string, string> = {
  decision: "Decisions",
  action: "Actions",
  intent: "Intents",
  rule: "Rules",
  scope: "Scopes",
  eval: "Evals",
  reference: "References",
  reasoning: "Reasonings",
  idea: "Ideas",
};

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1) + "s";
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
    const rawItems = (
      await c.query<Omit<FeedItem, "scopes">>(
        `SELECT id, node_type, summary, created_at::text, title, name FROM (
           SELECT id, 'decision' AS node_type, summary, created_at, NULL AS title, NULL AS name FROM decisions WHERE doco_id = $1
           UNION ALL
           SELECT id, 'intent' AS node_type, summary, created_at, NULL AS title, NULL FROM intents WHERE doco_id = $1
           UNION ALL
           SELECT id, 'idea' AS node_type, summary, created_at, NULL, NULL FROM ideas WHERE doco_id = $1
           UNION ALL
           SELECT id, 'rule' AS node_type, summary, created_at, NULL, NULL FROM rules WHERE doco_id = $1
           UNION ALL
           SELECT id, 'action' AS node_type, summary, created_at, NULL, NULL FROM actions WHERE doco_id = $1
           UNION ALL
           SELECT id, 'reasoning' AS node_type, summary, created_at, NULL, NULL FROM reasoning WHERE doco_id = $1
           UNION ALL
           SELECT id, 'eval' AS node_type, summary, created_at, NULL AS title, NULL FROM evals WHERE doco_id = $1
           UNION ALL
           SELECT id, 'scope' AS node_type, summary, created_at, NULL, name FROM scopes WHERE doco_id = $1
         ) t
         ORDER BY created_at DESC LIMIT $2`,
        [ctx.meta.docoId, FEED_LIMIT],
      )
    ).rows;

    let scopeEdges: { from_id: string; to_id: string }[] = [];
    if (rawItems.length > 0) {
      scopeEdges = (
        await c.query<{ from_id: string; to_id: string }>(
          `SELECT from_id, to_id FROM edges
            WHERE edge_type = 'in_scope_of'
              AND doco_id = $1
              AND from_id = ANY($2::text[])`,
          [ctx.meta.docoId, rawItems.map((r) => r.id)],
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
      const sids = scopeIdsByItem.get(it.id) ?? [];
      const scopes = sids
        .map((id) => scopeById.get(id))
        .filter((s): s is NonNullable<typeof s> => s != null)
        .map((s) => (s.icon ? { name: s.name, icon: s.icon } : { name: s.name }));
      return { ...it, scopes };
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
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM reasoning WHERE doco_id = $1
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

function scopeSearchPath(ownerSlug: string, docoSlug: string, scopeName: string): string {
  const params = new URLSearchParams();
  params.set("scope", scopeName);
  params.set("node_type", "*");
  params.set("lifecycle", "*");
  params.set("limit", "500");
  return `/${ownerSlug}/${docoSlug}/search?${params.toString()}`;
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
        href: scopeSearchPath(ownerSlug, docoSlug, s.name),
        label: (
          <span className="inline-flex items-center gap-2">
            {s.icon ? (
              <span aria-hidden="true" className="text-base leading-none">
                {s.icon}
              </span>
            ) : null}
            <span className="font-mono">{s.name}</span>
          </span>
        ),
        count: s.count,
        ariaLabel: `Search ${s.count} nodes in scope ${s.name}`,
        color: nodeTypeColor("scope"),
      })),
    },
    {
      title: "Node types",
      items: facets.nodeType.map((t) => ({
        key: `type-${t.value}`,
        href: nodeTypeSearchPath(ownerSlug, docoSlug, t.value),
        label: <NodeTypeBadge nodeType={t.value}>{nodeTypeLabel(t.value)}</NodeTypeBadge>,
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
        label: <Badge>{l.value}</Badge>,
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
          <aside className="min-[840px]:col-span-5">
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
                <p className="text-xs italic text-muted-foreground">
                  This Doco has no nodes yet.
                </p>
              }
            />
          </aside>

          {/* Right: activity heatmap above the real-time feed. */}
          <section className="min-[840px]:col-span-7 space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Latest activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {items.length === 0 ? (
                    <div className="px-5 py-6 text-xs text-muted-foreground">
                      This Doco has no entities yet. Set up scopes via{" "}
                      <Link
                        to={`/${ownerSlug}/${docoSlug}/scopes/new`}
                        className="text-primary hover:underline"
                      >
                        scopes/new
                      </Link>
                      , or add intents/rules/decisions under
                      <code className="mx-1 rounded bg-input px-1">{`docos/${ownerSlug}/${docoSlug}/`}</code>
                      and run <code className="mx-1 rounded bg-input px-1">doco reindex</code>.
                    </div>
                  ) : null}
                  {items.map((it) => (
                    <FeedLine key={it.id} item={it} ownerSlug={ownerSlug} docoSlug={docoSlug} />
                  ))}
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </main>
    </div>
  );
}

function capType(t: string): string {
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
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
        className="rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
      >
        Search
      </button>
    </Form>
  );
}

/**
 * Render one feed entry. Shape mirrors `renderOperationLines` in
 * capture.server.ts (sans the agent-only `[🔮 Doco]` prefix):
 *   ✍️ <Type> added: <summary> — <icon> <scope1>, …          Ns ago
 * The `<summary>` is the link to the entity; the right gutter carries
 * the relative age in the same Ns/Nm/Nh/Nd shape used elsewhere in the
 * UI (entity-detail metadata, graph nodes, …).
 */
function FeedLine({
  item,
  ownerSlug,
  docoSlug,
}: {
  item: FeedItem;
  ownerSlug: string;
  docoSlug: string;
}) {
  const url = `/${ownerSlug}/${docoSlug}/${item.node_type}/${item.id}`;
  const Type = capType(item.node_type);
  return (
    <div className="flex items-baseline gap-3 px-5 py-3 font-mono text-xs leading-relaxed text-foreground">
      <div className="min-w-0 flex-1">
        <span>✍️ </span>
        <span className="font-semibold">{Type} added</span>
        <span className="text-muted-foreground">: </span>
        <Link to={url} className="text-primary hover:underline">
          {item.summary}
        </Link>
        {item.scopes.length > 0 ? (
          <>
            <span className="text-muted-foreground"> — </span>
            {item.scopes.map((s, i) => (
              <span key={`${s.name}-${i}`} className="text-muted-foreground">
                {i > 0 ? ", " : null}
                {s.icon ? `${s.icon} ` : null}
                {s.name}
              </span>
            ))}
          </>
        ) : null}
      </div>
      <time
        dateTime={item.created_at}
        title={item.created_at}
        suppressHydrationWarning
        className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
      >
        {relativeTimeIso(item.created_at)}
      </time>
    </div>
  );
}

/** Format an ISO timestamp as "Ns / Nm / Nh / Nd ago". */
function relativeTimeIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return relativeTimeMs(t);
}
