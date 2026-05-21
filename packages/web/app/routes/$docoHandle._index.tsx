import { withClient } from "@doco/db";
// Per-Doco home — bare title up top, then the search input, node overview,
// activity heatmap, and latest activity feed in a single content column.
//
// The feed renders one line per recent audit event in the same family as
// agent footer lines: `<op-icon> <Type> <verb>: <readable text>`. Lifecycle
// transitions include their old → new value so state changes show up in
// the feed instead of disappearing behind the entity's original created_at.
//
// Live feed (ADR-089): re-fetch every 5s so new entities show up
// without a manual refresh. React Router 7's useRevalidator re-runs the
// loader. We only poll when the tab is visible to avoid burning cycles
// on idle tabs.
import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import { parse as parseYaml } from "yaml";
import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { InviteCollaboratorsLink } from "~/components/invite-collaborators-link";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { NodesOverviewCard, type NodesOverviewSection } from "~/components/nodes-overview-card";
import { OverviewGraph } from "~/components/overview-graph";
import { SearchBoxWithHistory } from "~/components/search-box-with-history";
import { SiteHeader } from "~/components/site-header";
import { docoPath } from "~/lib/db.server";
import { canAdminDoco, loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadOverviewGraph } from "~/lib/full-graph.server";
import { loadHostConfig } from "~/lib/host";
import { lifecycleColor } from "~/lib/node-colors";
import { computeFilterFacets } from "~/lib/search-filters.server";
import { timeAgo } from "~/lib/time-ago";

const FEED_LIMIT = 30;
const HEATMAP_WEEKS = 52;
const TOP_CONTRIBUTORS_LIMIT = 10;

interface FeedItem extends ActivityFeedLineItem {
  event_id: string;
}

interface TopContributor {
  principalId: string;
  username: string;
  lastAt: string;
  eventCount: number;
}

const NODE_TYPE_LABELS: Record<string, string> = {
  decision: "Decisions",
  action: "Actions",
  intent: "Intents",
  rule: "Rules",
  guidance_article: "Guidance articles",
  node_authoring_article: "Node authoring articles",
  eval: "Evals",
  reference: "References",
  idea: "Ideas",
};

function nodeTypeLabel(type: string): string {
  return (
    NODE_TYPE_LABELS[type] ??
    `${type
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")}s`
  );
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const ctx = await loadDocoForRead(request, handle);
  const me = ctx.me;
  const dir = docoPath(handle);
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
    const entityById = new Map<string, { label: string | null; lifecycle: string | null }>();
    if (entityIds.length > 0) {
      const entityLabelRows = await c.query<{
        id: string;
        label: string | null;
        lifecycle: string | null;
      }>(
        `SELECT id, summary AS label, lifecycle FROM decisions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM intents WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM ideas WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM rules WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM guidance_articles WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM node_authoring_articles WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM actions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM logs WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM evals WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM states WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM reference_entities WHERE doco_id = $1 AND id = ANY($2::text[])`,
        [ctx.meta.docoId, entityIds],
      );
      for (const row of entityLabelRows.rows) {
        entityById.set(row.id, { label: row.label, lifecycle: row.lifecycle });
      }
    }

    const items: FeedItem[] = rawItems.map((it) => {
      const entity = entityById.get(it.entity_id);
      return {
        event_id: it.event_id,
        id: it.entity_id,
        node_type: it.entity_type,
        summary:
          entity?.label ??
          stringField(it.after_json, "summary") ??
          stringField(it.before_json, "summary"),
        lifecycle: entity?.lifecycle ?? null,
        at: it.at instanceof Date ? it.at.toISOString() : new Date(String(it.at)).toISOString(),
        op: it.op,
        before: it.before_json,
        after: it.after_json,
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
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM guidance_articles WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM node_authoring_articles WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM actions WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM logs WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM evals WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM reference_entities WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM states WHERE doco_id = $1
         ) t WHERE day >= $2
         GROUP BY day`,
        [ctx.meta.docoId, sinceIso.slice(0, 10)],
      )
    ).rows;
    const byDay: Record<string, number> = {};
    for (const r of activityRows) byDay[r.day] = Number(r.n);

    const contributorRows = (
      await c.query<{
        principal_id: string;
        username: string;
        last_at: Date | string;
        event_count: string;
      }>(
        `SELECT ae.by_principal AS principal_id,
                p.username,
                MAX(ae.at) AS last_at,
                COUNT(*)::text AS event_count
           FROM audit_events ae
           JOIN principals p ON p.id = ae.by_principal
          WHERE ae.doco_id = $1 AND ae.by_principal IS NOT NULL
          GROUP BY ae.by_principal, p.username
          ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
          LIMIT $2`,
        [ctx.meta.docoId, TOP_CONTRIBUTORS_LIMIT],
      )
    ).rows;
    const topContributors: TopContributor[] = contributorRows.map((r) => ({
      principalId: r.principal_id,
      username: r.username,
      lastAt:
        r.last_at instanceof Date
          ? r.last_at.toISOString()
          : new Date(String(r.last_at)).toISOString(),
      eventCount: Number(r.event_count),
    }));
    const graph = await loadOverviewGraph(c, ctx.meta.docoId, { handle });

    return {
      items,
      facets,
      totalNodes,
      byDay,
      topContributors,
      ownerSlug,
      docoSlug,
      handle,
      docoId: ctx.meta.docoId,
      canInviteCollaborators: await canAdminDoco(ctx.meta, me?.id ?? null),
      host: await loadHostConfig(),
      me,
      graph,
    };
  });
}

function allNodesSearchPath(handle: string): string {
  const params = new URLSearchParams();
  params.set("node_type", "*");
  params.set("lifecycle", "*");
  params.set("limit", "500");
  return `/${handle}/search?${params.toString()}`;
}

function nodeTypeSearchPath(handle: string, nodeType: string): string {
  const params = new URLSearchParams();
  params.set("node_type", nodeType);
  params.set("lifecycle", "*");
  params.set("limit", "500");
  return `/${handle}/search?${params.toString()}`;
}

function lifecycleSearchPath(handle: string, lifecycle: string): string {
  const params = new URLSearchParams();
  params.set("lifecycle", lifecycle);
  params.set("node_type", "*");
  params.set("limit", "500");
  return `/${handle}/search?${params.toString()}`;
}

export function meta({ params }: { params: { docoId: string } }) {
  return [{ title: `${params.docoId} · Doco` }];
}

export default function DocoHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const {
    items,
    facets,
    totalNodes,
    byDay,
    topContributors,
    ownerSlug,
    docoSlug,
    handle,
    docoId,
    canInviteCollaborators,
    me,
    graph,
  } = loaderData;

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

  const allSearchHref = allNodesSearchPath(handle);

  const sections: NodesOverviewSection[] = [
    {
      title: "Node types",
      items: facets.nodeType.map((t) => ({
        key: `type-${t.value}`,
        href: nodeTypeSearchPath(handle, t.value),
        label: nodeTypeLabel(t.value),
        icon: <NodeTypeIcon nodeType={t.value} />,
        count: t.count,
        activeCount: t.activeCount,
        ariaLabel: `Search ${t.count} ${nodeTypeLabel(t.value).toLowerCase()}`,
        updatedAt: t.updatedAt,
      })),
    },
    {
      title: "Lifecycle",
      items: facets.lifecycle.map((l) => ({
        key: `lifecycle-${l.value}`,
        href: lifecycleSearchPath(handle, l.value),
        label: l.value,
        count: l.count,
        ariaLabel: `Search ${l.count} nodes in lifecycle ${l.value}`,
        color: lifecycleColor(l.value),
        updatedAt: l.updatedAt,
      })),
    },
  ];

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-[1800px] px-6 py-6">
        <div className="grid gap-6 md:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">
          <section className="min-w-0 space-y-5">
            {/* Bare title — no card wrapper. */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle })} />
                <h1 className="text-lg font-semibold tracking-tight">
                  <Link to={allSearchHref} className="hover:text-primary">
                    {handle}
                  </Link>
                </h1>
                <p className="font-mono text-sm text-muted-foreground">{docoId}</p>
              </div>
              {canInviteCollaborators ? (
                <InviteCollaboratorsLink level="doco" targetId={docoId} />
              ) : null}
            </div>

            <NodesOverviewCard
              sections={sections}
              search={
                <SearchBoxWithHistory
                  handle={handle}
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
              aside={<TopContributorsList contributors={topContributors} />}
            />

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
                    No recorded activity yet. Capture a node from the API or CLI; this feed records
                    UI, CLI, and API writes.
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

          <aside className="min-w-0 space-y-2 xl:sticky xl:top-4 xl:flex xl:h-[calc(100vh-7rem)] xl:flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold tracking-tight">Doco graph</h2>
              <span className="font-mono text-xs text-muted-foreground">
                {graph.nodes.length} nodes · {graph.links.length} links
              </span>
            </div>
            <div className="h-[70vh] min-h-[520px] xl:min-h-0 xl:flex-1">
              <OverviewGraph
                centerId={graph.centerId}
                nodes={graph.nodes}
                links={graph.links}
                detailUrl={graph.detailUrl}
                fillHeight
              />
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

function stringField(
  obj: Record<string, unknown> | null | undefined,
  field: string,
): string | null {
  const value = obj?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function TopContributorsList({ contributors }: { contributors: TopContributor[] }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs font-semibold text-foreground">Top contributors</h2>
      {contributors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No recorded contributions yet.</p>
      ) : (
        contributors.map((c) => (
          <div
            key={c.principalId}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
          >
            <span className="truncate text-xs" title={c.username}>
              {c.username}
            </span>
            <time
              dateTime={c.lastAt}
              title={c.lastAt}
              suppressHydrationWarning
              className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
            >
              {timeAgo(c.lastAt)}
            </time>
          </div>
        ))
      )}
    </section>
  );
}
