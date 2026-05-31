// /orgs/:orgHandle — per-Org home. Mirrors the host Docos/Orgs
// two-column layout at org scope. Left column carries:
//   - Header (org handle + ULID, +Agent/User on desktop)
//   - Search box (submits to /orgs/:orgHandle/search)
//   - Docos in this org (with a +Doco button)
//   - Top contributors across the org's Docos
// Right column carries:
//   - Activity heatmap (52w)
//   - Latest activity feed (20 events, with per-row Doco context)

import { getOrgRole, withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { Form, Link } from "react-router";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { DocoListCard, type DocoListEntry } from "~/components/doco-list-card";
import { ApiKeysLink, UsersLink } from "~/components/invite-users-link";
import { SiteHeader } from "~/components/site-header";
import {
  activityRowLifecycle,
  auditSummaryFallback,
  capNodeType,
  iconFromAuditOp,
  lifecycleTransitionText,
  shouldStrikeActivityTarget,
  verbFromAuditOp,
} from "~/lib/activity-feed";
import { cn } from "~/lib/cn";
import { listDocoStats } from "~/lib/doco-stats.server";
import { lifecycleColor } from "~/lib/node-colors";
import { resolveOrgByHandle } from "~/lib/org-helpers.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { timeAgo } from "~/lib/time-ago";

const FEED_LIMIT = 20;
const HEATMAP_WEEKS = 52;
const TOP_CONTRIBUTORS_LIMIT = 10;

interface OrgDoco {
  docoId: string;
  handle: string;
  nodes: number;
  lastUpdatedAt: string | null;
}

interface TopContributor {
  userId: string;
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
  const canInviteUsers = myRole === "owner";

  return withClient(async (c) => {
    // Docos owned by this org.
    const docoRows = (
      await c.query<{ id: string; handle: string }>(
        "SELECT id, handle FROM docos WHERE org_id = $1 ORDER BY handle",
        [org.id],
      )
    ).rows;
    const docoIds = docoRows.map((r) => String(r.id));
    const statsByDocoId = await listDocoStats(docoIds);

    const docos: OrgDoco[] = docoRows
      .map((r): OrgDoco => {
        const id = String(r.id);
        const stats = statsByDocoId.get(id) ?? { nodes: 0, lastUpdatedAt: null };
        return {
          docoId: id,
          handle: String(r.handle),
          nodes: stats.nodes,
          lastUpdatedAt: stats.lastUpdatedAt,
        };
      })
      .sort((a, b) => {
        if (a.lastUpdatedAt && b.lastUpdatedAt)
          return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
        if (a.lastUpdatedAt) return -1;
        if (b.lastUpdatedAt) return 1;
        return a.handle.localeCompare(b.handle);
      });

    const byDay: Record<string, number> = {};
    let topContributors: TopContributor[] = [];
    let items: FeedItem[] = [];

    if (docoIds.length > 0) {
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

      const contributorRows = (
        await c.query<{
          user_id: string;
          user_name: string;
          last_at: Date | string;
          event_count: string;
        }>(
          `SELECT ae.by_user AS user_id,
                  COALESCE(c.github_login, c.email, c.id) AS user_name,
                  MAX(ae.at) AS last_at,
                  COUNT(*)::text AS event_count
             FROM audit_events ae
             JOIN users c ON c.id = ae.by_user
            WHERE ae.doco_id = ANY($1::text[])
            GROUP BY ae.by_user, c.github_login, c.email, c.id
            ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
            LIMIT $2`,
          [docoIds, TOP_CONTRIBUTORS_LIMIT],
        )
      ).rows;
      topContributors = contributorRows.map((r) => ({
        userId: String(r.user_id),
        username: String(r.user_name),
        lastAt:
          r.last_at instanceof Date
            ? r.last_at.toISOString()
            : new Date(String(r.last_at)).toISOString(),
        eventCount: Number(r.event_count),
      }));

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
          user_name: string | null;
        }>(
          `SELECT a.event_id, a.at, a.doco_id, a.entity_type, a.entity_id, a.op,
                  a.before_json, a.after_json,
                  COALESCE(c.github_login, c.email, c.id) AS user_name
             FROM audit_events a
             LEFT JOIN users c ON c.id = a.by_user
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
          // Post-collapse: the 9 prose node types live in `nodes`
          // (labels = first line of `prose`); policies keep their own
          // tables and `policy` column. Principals aren't shown here.
          `SELECT id, split_part(prose, E'\n', 1) AS label, lifecycle
             FROM nodes
            WHERE id = ANY($1::text[])
              AND node_type IN ('decision', 'intent', 'idea', 'rule', 'action', 'log', 'eval', 'state', 'reference')
           UNION ALL SELECT id, policy AS label, lifecycle FROM guidance_policies WHERE id = ANY($1::text[])
           UNION ALL SELECT id, policy AS label, lifecycle FROM node_authoring_policies WHERE id = ANY($1::text[])`,
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
          byUsername: r.user_name ? String(r.user_name) : null,
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
      canInviteUsers,
      docos,
      byDay,
      topContributors,
      items,
    };
  });
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `${params.orgHandle} · Doco` }];
}

export default function OrgHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { org, me, canInviteUsers, docos, byDay, topContributors, items } = loaderData;
  const docoItems: DocoListEntry[] = docos.map((d) => ({
    id: d.docoId,
    href: `/${d.handle}`,
    handle: d.handle,
    ownerHandle: org.handle,
    nodeCount: d.nodes,
    lastUpdatedAt: d.lastUpdatedAt,
  }));

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <Breadcrumb items={orgBreadcrumb({ orgSlug: org.handle })} />
            <h1 className="text-2xl font-semibold">{org.handle}</h1>
            <p className="font-mono text-xs text-muted-foreground">{org.id}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canInviteUsers ? <UsersLink level="org" targetId={org.id} /> : null}
            {canInviteUsers ? <ApiKeysLink /> : null}
            {canInviteUsers ? (
              <Link
                to={`/orgs/${org.handle}/settings`}
                className="neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold"
              >
                Settings
              </Link>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 min-[840px]:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0 space-y-4">
            <Form method="get" action={`/orgs/${org.handle}/search`} className="flex gap-2">
              <input
                name="q"
                type="search"
                placeholder={`Search across ${docos.length} doco${docos.length === 1 ? "" : "s"}...`}
                className="w-full rounded-md px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              />
              <button
                type="submit"
                className="neu-button rounded-md px-4 py-2.5 text-sm font-semibold text-foreground"
              >
                Search
              </button>
            </Form>

            <DocoListCard
              title="Docos in this org"
              headerAction={
                <Link
                  to={`/new-doco?org_id=${encodeURIComponent(org.id)}`}
                  className="neu-button rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90"
                >
                  + Doco
                </Link>
              }
              docos={docoItems}
              empty={
                <p className="text-xs italic text-muted-foreground">
                  This org doesn't own any Docos yet.
                </p>
              }
            />

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Top contributors</CardTitle>
              </CardHeader>
              <CardContent>
                {topContributors.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">
                    No recorded contributions yet.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {topContributors.map((c) => (
                      <li
                        key={c.userId}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs"
                      >
                        <span className="truncate" title={c.username}>
                          {c.username}
                        </span>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                          {c.eventCount}
                        </span>
                        <time
                          dateTime={c.lastAt}
                          title={c.lastAt}
                          suppressHydrationWarning
                          className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
                        >
                          {timeAgo(c.lastAt)}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>

          <aside className="space-y-4">
            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Activity</CardTitle>
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
          </aside>
        </div>
      </main>
    </div>
  );
}

// Cross-Doco feed line: same shape as the dashboard's DashboardFeedLine.
// Each event carries its own Doco context (handle + cross-Doco entity URL)
// because an org's feed spans every Doco it owns.
function OrgFeedLine({ event }: { event: FeedItem }) {
  const url = entityUrl({
    docoHandle: event.handle,
    entityType: event.entity_type,
    id: event.entity_id,
  });
  const summary = event.summary ?? auditSummaryFallback(event.entity_type, event.entity_id);
  const detail = lifecycleTransitionText(event);
  const strikeTarget = shouldStrikeActivityTarget(event);
  const lifecycleHex = lifecycleColor(activityRowLifecycle(event));
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
          style={{ color: lifecycleHex }}
          className={cn("hover:underline", strikeTarget && "line-through decoration-2")}
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
