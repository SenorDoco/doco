// /orgs/:orgHandle — per-Org home. Mirrors the Doco home page
// (/$docoHandle._index.tsx) but aggregates across every Doco the org
// owns: a "Docos in this org" list, aggregate node-type/lifecycle
// facets, an aggregate activity heatmap, a cross-Doco latest-activity
// feed (each row carries its own Doco context), and a Members /
// Top-contributors sidebar in place of the per-Doco graph (no
// org-level graph exists yet).

import { type DocoRole, getOrgRole, withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { InviteCollaboratorsLink } from "~/components/invite-collaborators-link";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { NodesOverviewCard, type NodesOverviewSection } from "~/components/nodes-overview-card";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import {
  auditSummaryFallback,
  capNodeType,
  iconFromAuditOp,
  lifecycleTransitionText,
  shouldStrikeActivityTarget,
  verbFromAuditOp,
} from "~/lib/activity-feed";
import { cn } from "~/lib/cn";
import { listDocoStats } from "~/lib/doco-stats.server";
import { loadHostConfig } from "~/lib/host";
import { lifecycleColor } from "~/lib/node-colors";
import { getCurrentPrincipal } from "~/lib/session";
import { timeAgo } from "~/lib/time-ago";

const FEED_LIMIT = 30;
const HEATMAP_WEEKS = 52;
const TOP_CONTRIBUTORS_LIMIT = 10;

// Same set the Doco page aggregates over (PG_DOCO_TABLES_WITH_LIFECYCLE
// in ~/lib/search-filters.server.ts). Kept in sync by hand — both
// files own a tiny static list and don't grow often.
const NODE_TABLES = [
  "intents",
  "ideas",
  "rules",
  "guidance_articles",
  "node_authoring_articles",
  "decisions",
  "actions",
  "logs",
  "evals",
  "reference_entities",
  "states",
] as const;

const TABLE_TO_NODE_TYPE: Record<string, string> = {
  intents: "intent",
  ideas: "idea",
  rules: "rule",
  guidance_articles: "guidance_article",
  node_authoring_articles: "node_authoring_article",
  decisions: "decision",
  actions: "action",
  logs: "log",
  evals: "eval",
  reference_entities: "reference",
  states: "state",
};

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

interface OrgRow {
  id: string;
  slug: string;
  handle: string;
  name: string;
}

interface OrgDoco {
  docoId: string;
  handle: string;
  visibility: "private" | "public";
  nodes: number;
  edges: number;
  lastUpdatedAt: string | null;
}

interface MemberRow {
  principalId: string;
  username: string;
  role: DocoRole;
  joinedAt: string;
}

interface TopContributor {
  principalId: string;
  username: string;
  lastAt: string;
  eventCount: number;
}

interface FeedItem {
  event_id: string;
  at: string;
  byUsername: string | null;
  handle: string;
  entity_type: string;
  entity_id: string;
  summary: string | null;
  lifecycle: string | null;
  op: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

interface NodeFacet {
  value: string;
  count: number;
  activeCount: number;
  updatedAt: string | null;
}

interface LifecycleFacet {
  value: string;
  count: number;
  updatedAt: string | null;
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
  const myRole = me ? await getOrgRole(org.id, me.id) : null;
  const canInviteCollaborators = myRole === "owner";

  return withClient(async (c) => {
    // Docos owned by this org.
    const docoRows = (
      await c.query<{ id: string; handle: string; visibility: string }>(
        "SELECT id, handle, visibility FROM docos WHERE owner_id = $1 ORDER BY handle",
        [org.id],
      )
    ).rows;
    const docoIds = docoRows.map((r) => String(r.id));
    const statsByDocoId = await listDocoStats(docoIds);
    const docos: OrgDoco[] = docoRows.map((r) => {
      const id = String(r.id);
      const stats = statsByDocoId.get(id) ?? { nodes: 0, edges: 0, lastUpdatedAt: null };
      return {
        docoId: id,
        handle: String(r.handle),
        visibility: r.visibility === "public" ? "public" : "private",
        nodes: stats.nodes,
        edges: stats.edges,
        lastUpdatedAt: stats.lastUpdatedAt,
      };
    });

    // Members.
    const memberRows = (
      await c.query<{
        principal_id: string;
        username: string;
        role: string;
        joined_at: Date | string;
      }>(
        `SELECT m.principal_id, p.username, m.role, m.joined_at
           FROM org_users m
           JOIN principals p ON p.id = m.principal_id
          WHERE m.org_id = $1
          ORDER BY m.joined_at`,
        [org.id],
      )
    ).rows;
    const members: MemberRow[] = memberRows.map((r) => ({
      principalId: String(r.principal_id),
      username: String(r.username),
      role: (r.role as DocoRole) ?? "reader",
      joinedAt: r.joined_at instanceof Date ? r.joined_at.toISOString() : String(r.joined_at),
    }));

    // Aggregate node-type + lifecycle facets across the org's docos.
    const nodeType: NodeFacet[] = [];
    let lifecycle: LifecycleFacet[] = [];
    let totalNodes = 0;
    const byDay: Record<string, number> = {};
    let topContributors: TopContributor[] = [];
    let items: FeedItem[] = [];

    if (docoIds.length > 0) {
      const lifecycleAgg = new Map<string, { count: number; updatedAt: string | null }>();
      for (const t of NODE_TABLES) {
        const r = await c.query<{ value: string; n: string; updated_at: Date | string | null }>(
          `SELECT COALESCE(lifecycle, 'active') AS value,
                  COUNT(*)::text AS n,
                  MAX(updated_at) AS updated_at
             FROM ${t}
            WHERE doco_id = ANY($1::text[])
            GROUP BY value`,
          [docoIds],
        );
        for (const row of r.rows) {
          const n = Number(row.n);
          const current = lifecycleAgg.get(row.value) ?? { count: 0, updatedAt: null };
          lifecycleAgg.set(row.value, {
            count: current.count + n,
            updatedAt: latestIso(current.updatedAt, toIso(row.updated_at)),
          });
        }
      }
      lifecycle = Array.from(lifecycleAgg.entries())
        .map(([value, f]) => ({ value, count: f.count, updatedAt: f.updatedAt }))
        .sort((a, b) => {
          if (a.value === "active") return -1;
          if (b.value === "active") return 1;
          return a.value.localeCompare(b.value);
        });

      for (const t of NODE_TABLES) {
        const r = await c.query<{
          n: string;
          active_n: string;
          updated_at: Date | string | null;
        }>(
          `SELECT COUNT(*)::text AS n,
                  (COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'active'))::text AS active_n,
                  MAX(updated_at) AS updated_at
             FROM ${t} WHERE doco_id = ANY($1::text[])`,
          [docoIds],
        );
        const row = r.rows[0];
        const n = Number(row?.n ?? 0);
        if (n > 0) {
          nodeType.push({
            value: TABLE_TO_NODE_TYPE[t] ?? t,
            count: n,
            activeCount: Number(row?.active_n ?? 0),
            updatedAt: toIso(row?.updated_at),
          });
        }
      }
      nodeType.sort((a, b) => b.count - a.count);
      totalNodes = nodeType.reduce((sum, t) => sum + t.count, 0);

      // Activity heatmap — 52w of audit events across the org's docos.
      const since = new Date();
      since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
      const sinceIso = since.toISOString();
      const heatRows = (
        await c.query<{ day: string; n: string }>(
          `SELECT to_char(at, 'YYYY-MM-DD') AS day, COUNT(*)::text AS n
             FROM audit_events
            WHERE doco_id = ANY($1::text[]) AND at >= $2
            GROUP BY day`,
          [docoIds, sinceIso],
        )
      ).rows;
      for (const r of heatRows) byDay[r.day] = Number(r.n);

      // Top contributors.
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
            WHERE ae.doco_id = ANY($1::text[]) AND ae.by_principal IS NOT NULL
            GROUP BY ae.by_principal, p.username
            ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
            LIMIT $2`,
          [docoIds, TOP_CONTRIBUTORS_LIMIT],
        )
      ).rows;
      topContributors = contributorRows.map((r) => ({
        principalId: String(r.principal_id),
        username: String(r.username),
        lastAt:
          r.last_at instanceof Date
            ? r.last_at.toISOString()
            : new Date(String(r.last_at)).toISOString(),
        eventCount: Number(r.event_count),
      }));

      // Latest activity feed, cross-Doco.
      const feedRows = (
        await c.query<{
          event_id: string;
          at: Date | string;
          doco_id: string;
          entity_type: string;
          entity_id: string;
          op: string;
          before_json: Record<string, unknown> | null;
          after_json: Record<string, unknown> | null;
          username: string | null;
        }>(
          `SELECT a.event_id, a.at, a.doco_id, a.entity_type, a.entity_id, a.op,
                  a.before_json, a.after_json, p.username
             FROM audit_events a
             LEFT JOIN principals p ON p.id = a.by_principal
            WHERE a.doco_id = ANY($1::text[])
            ORDER BY a.at DESC
            LIMIT $2`,
          [docoIds, FEED_LIMIT],
        )
      ).rows;
      const entityIds = Array.from(new Set(feedRows.map((r) => r.entity_id)));
      const entityById = new Map<string, { label: string | null; lifecycle: string | null }>();
      if (entityIds.length > 0) {
        const entityLabelRows = await c.query<{
          id: string;
          label: string | null;
          lifecycle: string | null;
        }>(
          `SELECT id, summary AS label, lifecycle FROM decisions WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM intents WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM ideas WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM rules WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM guidance_articles WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM node_authoring_articles WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM actions WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM logs WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM evals WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM states WHERE id = ANY($1::text[])
           UNION ALL SELECT id, summary AS label, lifecycle FROM reference_entities WHERE id = ANY($1::text[])`,
          [entityIds],
        );
        for (const r of entityLabelRows.rows) {
          entityById.set(String(r.id), { label: r.label, lifecycle: r.lifecycle });
        }
      }
      const docoMap = new Map(docos.map((d) => [d.docoId, d]));
      items = feedRows.map((r) => {
        const d = docoMap.get(String(r.doco_id));
        const entity = entityById.get(String(r.entity_id));
        return {
          event_id: String(r.event_id),
          at: r.at instanceof Date ? r.at.toISOString() : new Date(String(r.at)).toISOString(),
          byUsername: r.username ? String(r.username) : null,
          handle: d?.handle ?? "?",
          entity_type: String(r.entity_type),
          entity_id: String(r.entity_id),
          summary: entity?.label ?? null,
          lifecycle: entity?.lifecycle ?? null,
          op: String(r.op),
          before: r.before_json,
          after: r.after_json,
        };
      });
    }

    return {
      org,
      me,
      host: await loadHostConfig(),
      myRole,
      canInviteCollaborators,
      docos,
      members,
      nodeType,
      lifecycle,
      totalNodes,
      byDay,
      topContributors,
      items,
    };
  });
}

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

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `${params.orgHandle} · Doco` }];
}

export default function OrgHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const {
    org,
    me,
    canInviteCollaborators,
    docos,
    members,
    nodeType,
    lifecycle,
    byDay,
    topContributors,
    items,
  } = loaderData;

  // Live feed polling — same shape as the Doco home (ADR-089).
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

  const sections: NodesOverviewSection[] = [
    {
      title: "Node types",
      items: nodeType.map((t) => ({
        key: `type-${t.value}`,
        href: `/orgs/${org.handle}`,
        label: nodeTypeLabel(t.value),
        icon: <NodeTypeIcon nodeType={t.value} />,
        count: t.count,
        activeCount: t.activeCount,
        ariaLabel: `${t.count} ${nodeTypeLabel(t.value).toLowerCase()} across this org's docos`,
        updatedAt: t.updatedAt,
      })),
    },
    {
      title: "Lifecycle",
      items: lifecycle.map((l) => ({
        key: `lifecycle-${l.value}`,
        href: `/orgs/${org.handle}`,
        label: l.value,
        count: l.count,
        ariaLabel: `${l.count} nodes in lifecycle ${l.value}`,
        color: lifecycleColor(l.value),
        updatedAt: l.updatedAt,
      })),
    },
  ];

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-[1800px] px-6 py-6">
        <div className="grid gap-6 md:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">
          <section className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h1 className="text-lg font-semibold tracking-tight">{org.handle}</h1>
                <p className="font-mono text-sm text-muted-foreground">{org.id}</p>
                <p className="text-xs text-muted-foreground">
                  <Link to={`/orgs/${org.handle}/constitution`} className="underline">
                    Constitution
                  </Link>
                  {" · "}
                  {members.length} member{members.length === 1 ? "" : "s"}
                  {" · "}
                  {docos.length} doco{docos.length === 1 ? "" : "s"}
                </p>
              </div>
              {canInviteCollaborators ? (
                <InviteCollaboratorsLink level="org" targetId={org.id} />
              ) : null}
            </div>

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Docos in this org</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {docos.length === 0 ? (
                  <p className="px-5 pb-5 text-xs italic text-muted-foreground">
                    This org doesn't own any Docos yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>handle</TableHead>
                        <TableHead className="text-right">nodes</TableHead>
                        <TableHead className="text-right">edges</TableHead>
                        <TableHead className="text-right">last updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {docos.map((d) => (
                        <TableRow key={d.docoId}>
                          <TableCell>
                            <Link to={`/${d.handle}`} className="text-primary hover:underline">
                              {d.handle}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right font-mono">{d.nodes}</TableCell>
                          <TableCell className="text-right font-mono">{d.edges}</TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {timeAgo(d.lastUpdatedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <NodesOverviewCard
              sections={sections}
              empty={
                <p className="text-xs italic text-muted-foreground">
                  No nodes captured across this org's Docos yet.
                </p>
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
                    No recorded activity yet across this org's Docos.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {items.map((it) => (
                      <OrgFeedLine key={it.event_id} event={it} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          <aside className="min-w-0 space-y-5">
            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Members</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {members.length === 0 ? (
                  <p className="px-5 pb-5 text-xs italic text-muted-foreground">No members yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {members.map((m) => (
                      <li
                        key={m.principalId}
                        className="flex items-center justify-between gap-3 px-5 py-2 text-xs"
                      >
                        <span className="truncate font-medium">{m.username}</span>
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">
                          {m.role}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
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

// Cross-Doco feed line: same shape as the dashboard's DashboardFeedLine.
// Each event carries its own Doco context (handle + cross-Doco entity URL)
// because an org's feed spans every Doco it owns.
function OrgFeedLine({ event }: { event: FeedItem }) {
  const url = entityUrl({
    docoId: event.handle,
    nodeType: event.entity_type,
    id: event.entity_id,
  });
  const summary = event.summary ?? auditSummaryFallback(event.entity_type, event.entity_id);
  const detail = lifecycleTransitionText(event);
  const strikeTarget = shouldStrikeActivityTarget(event);
  return (
    <div className="flex items-baseline gap-3 px-5 py-3 font-mono text-xs leading-relaxed text-foreground">
      <div className="min-w-0 flex-1">
        <span>{iconFromAuditOp(event.op)} </span>
        <span className="font-semibold">
          {capNodeType(event.entity_type)} {verbFromAuditOp(event.op)}
        </span>
        <span className="text-muted-foreground">: </span>
        <Link
          to={url}
          className={cn(
            "text-primary hover:underline",
            strikeTarget && "line-through decoration-2",
          )}
        >
          {summary}
        </Link>
        {detail ? <span className="text-muted-foreground">{detail}</span> : null}
        <span className="text-muted-foreground"> — </span>
        <Link
          to={`/${event.handle}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {event.handle}
        </Link>
        {event.byUsername ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">{event.byUsername}</span>
          </>
        ) : null}
      </div>
      <time
        dateTime={event.at}
        title={event.at}
        suppressHydrationWarning
        className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
      >
        {timeAgo(event.at)}
      </time>
    </div>
  );
}
