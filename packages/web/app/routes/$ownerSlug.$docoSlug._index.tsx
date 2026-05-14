// Per-Doco home — bare title up top, then the search input, then a
// two-column body: stats + activity heatmap on the left, "Latest
// Activity" feed on the right.
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
import { docoPath, openDocoDb } from "~/lib/db.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { listScopeDetails } from "~/lib/scope-helpers.server";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { ActivityHeatmap } from "~/components/activity-heatmap";

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

interface NodeTypeCount {
  type: string;
  label: string;
  count: number;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { me } = await loadDocoForRead(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);
  const scopeDetails = listScopeDetails(dir);
  const scopeById = new Map(scopeDetails.map((s) => [s.id, s]));
  const db = openDocoDb(ownerSlug, docoSlug);
  try {
    const rawItems = db
      .prepare(
        `SELECT id, node_type, summary, created_at, title, name FROM (
           SELECT id, 'decision' AS node_type, summary, created_at, NULL AS title, NULL AS name FROM decision
           UNION ALL
           SELECT id, 'intent' AS node_type, summary, created_at, title, NULL FROM intent
           UNION ALL
           SELECT id, 'idea' AS node_type, summary, created_at, NULL, NULL FROM idea
           UNION ALL
           SELECT id, 'rule' AS node_type, summary, created_at, NULL, NULL FROM rule
           UNION ALL
           SELECT id, 'action' AS node_type, summary, created_at, NULL, NULL FROM action
           UNION ALL
           SELECT id, 'reasoning' AS node_type, summary, created_at, NULL, NULL FROM reasoning
           UNION ALL
           SELECT id, 'eval' AS node_type, summary, created_at, name AS title, NULL FROM eval
           UNION ALL
           SELECT id, 'scope' AS node_type, summary, created_at, NULL, name FROM scope
         )
         ORDER BY created_at DESC LIMIT ${FEED_LIMIT}`,
      )
      .all() as Omit<FeedItem, "scopes">[];

    // Pull `in_scope_of` edges for the visible items in one shot.
    let scopeEdges: { from_id: string; to_id: string }[] = [];
    if (rawItems.length > 0) {
      const placeholders = rawItems.map(() => "?").join(",");
      scopeEdges = db
        .prepare(
          `SELECT from_id, to_id FROM edges
           WHERE edge_type = 'in_scope_of' AND from_id IN (${placeholders})`,
        )
        .all(...rawItems.map((r) => r.id)) as { from_id: string; to_id: string }[];
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

    // Stats: total nodes per type. Listed in the same order as the
    // capture/footer convention (decisions first, then actions, …).
    const counts: NodeTypeCount[] = [
      { type: "decision", label: "Decisions", count: countRows(db, "decision") },
      { type: "action", label: "Actions", count: countRows(db, "action") },
      { type: "intent", label: "Intents", count: countRows(db, "intent") },
      { type: "rule", label: "Rules", count: countRows(db, "rule") },
      { type: "scope", label: "Scopes", count: countRows(db, "scope") },
      { type: "eval", label: "Evals", count: countRows(db, "eval") },
      { type: "reference", label: "References", count: countRows(db, "reference") },
      { type: "reasoning", label: "Reasonings", count: countRows(db, "reasoning") },
      { type: "idea", label: "Ideas", count: countRows(db, "idea") },
    ];

    // Daily activity for the last HEATMAP_WEEKS weeks.
    const since = new Date();
    since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
    const sinceIso = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
    const activityRows = db
      .prepare(
        `SELECT day, COUNT(*) AS n FROM (
           SELECT substr(created_at, 1, 10) AS day FROM decision
           UNION ALL SELECT substr(created_at, 1, 10) FROM intent
           UNION ALL SELECT substr(created_at, 1, 10) FROM idea
           UNION ALL SELECT substr(created_at, 1, 10) FROM rule
           UNION ALL SELECT substr(created_at, 1, 10) FROM action
           UNION ALL SELECT substr(created_at, 1, 10) FROM reasoning
           UNION ALL SELECT substr(created_at, 1, 10) FROM eval
           UNION ALL SELECT substr(created_at, 1, 10) FROM scope
           UNION ALL SELECT substr(created_at, 1, 10) FROM reference
         ) WHERE day >= ?
         GROUP BY day`,
      )
      .all(sinceIso) as { day: string; n: number }[];
    const byDay: Record<string, number> = {};
    for (const r of activityRows) byDay[r.day] = r.n;

    return {
      items,
      counts,
      byDay,
      ownerSlug,
      docoSlug,
      host: await loadHostConfig(),
      me,
    };
  } finally {
    db.close();
  }
}

function countRows(db: ReturnType<typeof openDocoDb>, table: string): number {
  // Table name is a fixed literal from this module (never user input);
  // sqlite doesn't allow parameterised identifiers anyway.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export default function DocoHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { items, counts, byDay, ownerSlug, docoSlug, host, me } = loaderData;

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

  const totalNodes = counts.reduce((sum, c) => sum + c.count, 0);

  return (
    <div>
      <SiteHeader
        mode="host"
        me={me}
        docoScope={{ ownerSlug, docoSlug }}
      />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-5">
        {/* Bare title — no card wrapper. */}
        <h1 className="text-2xl font-semibold tracking-tight">
          {ownerSlug}/{docoSlug}
        </h1>

        {/* Search input — primary affordance, sits directly below the title. */}
        <SearchBoxWithHistory ownerSlug={ownerSlug} docoSlug={docoSlug} />

        <div className="grid grid-cols-1 gap-5 min-[840px]:grid-cols-12">
          {/* Left: stats with a heatmap on top. */}
          <aside className="min-[840px]:col-span-5 space-y-5">
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
                <CardTitle>Stats</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <dl className="divide-y divide-border">
                  {counts.map((c) => (
                    <div key={c.type} className="flex items-center justify-between py-2">
                      <dt className="text-sm text-foreground">
                        <Link
                          to={`/${ownerSlug}/${docoSlug}/${c.type}`}
                          className="hover:text-primary hover:underline"
                        >
                          {c.label}
                        </Link>
                      </dt>
                      <dd className="font-mono text-sm tabular-nums text-foreground">{c.count}</dd>
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-2 font-semibold">
                    <dt className="text-sm text-foreground">Total</dt>
                    <dd className="font-mono text-sm tabular-nums text-foreground">{totalNodes}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </aside>

          {/* Right: real-time feed of recently added entities. */}
          <section className="min-[840px]:col-span-7">
            <Card>
              <CardHeader>
                <CardTitle>Latest Activity</CardTitle>
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
                    <FeedLine
                      key={it.id}
                      item={it}
                      ownerSlug={ownerSlug}
                      docoSlug={docoSlug}
                    />
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
}: {
  ownerSlug: string;
  docoSlug: string;
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
          placeholder={`Search ${ownerSlug}/${docoSlug} — slugs, summaries, body, numbers…`}
          className="w-full rounded-md border border-border bg-input px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary"
          autoFocus
        />
        {showDropdown ? (
          <ul
            role="listbox"
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
