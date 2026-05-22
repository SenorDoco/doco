// /orgs — host-level "Your orgs" listing. Mirrors /docos: the orgs
// the signed-in principal belongs to, ordered by recent activity
// (MAX(audit_events.at) across each org's docos), plus an activity
// heatmap + latest-activity feed sidebar.

import { type DocoRole, getOrgRole, withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { Link, redirect } from "react-router";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import {
  auditSummaryFallback,
  capNodeType,
  iconFromAuditOp,
  lifecycleTransitionText,
  shouldStrikeActivityTarget,
  verbFromAuditOp,
} from "~/lib/activity-feed";
import { cn } from "~/lib/cn";
import { isMyDoco, listInvitedDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { ENTITY_TABLES } from "~/lib/doco-stats.server";
import { listAllDocos, listMyOrgs } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { timeAgo } from "~/lib/time-ago";

const HEATMAP_WEEKS = 52;
const FEED_LIMIT = 10;

interface OrgRow {
  id: string;
  slug: string;
  display_name: string;
  description?: string;
  docoCount: number;
  nodeCount: number;
  myRole: DocoRole;
  lastUpdatedAt: string | null;
}

interface FeedEvent {
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

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent("/orgs")}`);
  }

  const orgsRaw = await listMyOrgs(me.id);

  // Per-org aggregates (last activity across owned docos, doco count, total
  // node count summed across every entity table). Three pooled queries in
  // parallel since a single PoolClient serializes queries.
  const orgIds = orgsRaw.map((o) => o.id);
  const nodesUnionSql = ENTITY_TABLES.map((t) => `SELECT doco_id FROM ${t}`).join(" UNION ALL ");
  const [orgLastActivity, orgDocoCount, orgNodeCount] = await Promise.all([
    withClient(async (c) => {
      if (orgIds.length === 0) return new Map<string, string | null>();
      const r = await c.query<{ owner_id: string; last_at: string | null }>(
        `SELECT d.owner_id, MAX(a.at)::text AS last_at
           FROM audit_events a
           JOIN docos d ON d.id = a.doco_id
          WHERE d.owner_id = ANY($1)
          GROUP BY d.owner_id`,
        [orgIds],
      );
      const m = new Map<string, string | null>();
      for (const row of r.rows) m.set(String(row.owner_id), row.last_at);
      return m;
    }),
    withClient(async (c) => {
      if (orgIds.length === 0) return new Map<string, number>();
      const r = await c.query<{ owner_id: string; n: string }>(
        `SELECT owner_id, COUNT(*)::text AS n
           FROM docos
          WHERE owner_id = ANY($1)
          GROUP BY owner_id`,
        [orgIds],
      );
      const m = new Map<string, number>();
      for (const row of r.rows) m.set(String(row.owner_id), Number(row.n));
      return m;
    }),
    withClient(async (c) => {
      if (orgIds.length === 0) return new Map<string, number>();
      const r = await c.query<{ owner_id: string; n: string }>(
        `SELECT d.owner_id, COUNT(*)::text AS n
           FROM (${nodesUnionSql}) t
           JOIN docos d ON d.id = t.doco_id
          WHERE d.owner_id = ANY($1)
          GROUP BY d.owner_id`,
        [orgIds],
      );
      const m = new Map<string, number>();
      for (const row of r.rows) m.set(String(row.owner_id), Number(row.n));
      return m;
    }),
  ]);

  const orgs: OrgRow[] = (
    await Promise.all(
      orgsRaw.map(async (o) => ({
        ...o,
        myRole: ((await getOrgRole(o.id, me.id)) ?? "reader") as DocoRole,
        lastUpdatedAt: orgLastActivity.get(o.id) ?? null,
        docoCount: orgDocoCount.get(o.id) ?? 0,
        nodeCount: orgNodeCount.get(o.id) ?? 0,
      })),
    )
  ).sort((a, b) => {
    if (a.lastUpdatedAt && b.lastUpdatedAt) return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
    if (a.lastUpdatedAt) return -1;
    if (b.lastUpdatedAt) return 1;
    return a.slug.localeCompare(b.slug);
  });

  // Sidebar activity (same shape as /dashboard + /docos).
  const allDocos = await listAllDocos();
  const invitedDocoIds = await listInvitedDocoIdsForPrincipal(me.id);
  const mine = await Promise.all(allDocos.map((d) => isMyDoco({ ownerId: d.ownerId }, me.id)));
  const myDocos = allDocos.filter((d, i) => mine[i] || invitedDocoIds.has(d.docoId));
  const myDocoIds = myDocos.map((d) => d.docoId);

  const since = new Date();
  since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
  const sinceIso = since.toISOString();

  const { byDay, feed } = await withClient(async (c) => {
    const heatRows = await c.query<{ day: string; n: string }>(
      `SELECT to_char(at, 'YYYY-MM-DD') AS day, COUNT(*)::text AS n
         FROM audit_events
        WHERE (by_collaborator = $1
               OR by_collaborator IN (SELECT id FROM principals WHERE owner_id = $1))
          AND at >= $2
        GROUP BY day`,
      [me.id, sinceIso],
    );
    const byDay: Record<string, number> = {};
    for (const r of heatRows.rows) byDay[r.day] = Number(r.n);

    let feed: FeedEvent[] = [];
    if (myDocoIds.length > 0) {
      const feedRows = await c.query<{
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
           LEFT JOIN principals p ON p.id = a.by_collaborator
          WHERE a.doco_id = ANY($1)
            AND a.entity_type NOT IN ('guidance_primitive', 'neuron_authoring_primitive')
          ORDER BY a.at DESC
          LIMIT $2`,
        [myDocoIds, FEED_LIMIT],
      );
      const entityIds = Array.from(new Set(feedRows.rows.map((r) => r.entity_id)));
      const entityById = new Map<string, { label: string | null; lifecycle: string | null }>();
      if (entityIds.length > 0) {
        const entityLabelRows = await c.query<{
          id: string;
          label: string | null;
          lifecycle: string | null;
        }>(
          `SELECT id, summary AS label, lifecycle FROM decisions WHERE id = ANY($1)
           UNION ALL SELECT id, summary AS label, lifecycle FROM intents WHERE id = ANY($1)
           UNION ALL SELECT id, summary AS label, lifecycle FROM ideas WHERE id = ANY($1)
           UNION ALL SELECT id, summary AS label, lifecycle FROM rules WHERE id = ANY($1)
           UNION ALL SELECT id, summary AS label, lifecycle FROM actions WHERE id = ANY($1)
           UNION ALL SELECT id, summary AS label, lifecycle FROM logs WHERE id = ANY($1)
           UNION ALL SELECT id, summary AS label, lifecycle FROM evals WHERE id = ANY($1)
           UNION ALL SELECT id, summary AS label, lifecycle FROM reference_entities WHERE id = ANY($1)`,
          [entityIds],
        );
        for (const r of entityLabelRows.rows) {
          entityById.set(r.id, { label: r.label, lifecycle: r.lifecycle });
        }
      }
      const docoMap = new Map(myDocos.map((d) => [d.docoId, d]));
      feed = feedRows.rows.map((r) => {
        const d = docoMap.get(r.doco_id);
        const entity = entityById.get(r.entity_id);
        return {
          event_id: r.event_id,
          at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
          byUsername: r.username,
          handle: d?.handle ?? "?",
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          summary: entity?.label ?? null,
          lifecycle: entity?.lifecycle ?? null,
          op: r.op,
          before: r.before_json,
          after: r.after_json,
        };
      });
    }
    return { byDay, feed };
  });

  return { me, orgs, byDay, feed };
}

export function meta() {
  return [{ title: "Your orgs · Doco" }];
}

export default function OrgsIndexPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, orgs, byDay, feed } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-6">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Orgs" })} />
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Your orgs</h1>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/new-org"
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              + Org
            </Link>
            <Link
              to="/collaborators/invite"
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-semibold hover:bg-input"
            >
              + Collaborator (people/agents)
            </Link>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 min-[840px]:grid-cols-[minmax(0,1fr)_320px]">
          <section className="space-y-4">
            <Card>
              <CardContent>
                {orgs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    You aren't a member of any org yet.{" "}
                    <Link to="/new-org" className="underline">
                      Create one
                    </Link>
                    .
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {orgs.map((o) => (
                      <li key={o.id} className="py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Link to={`/orgs/${o.slug}`} className="font-medium hover:underline">
                              {o.slug}
                            </Link>
                            <div className="text-xs text-muted-foreground">
                              {o.docoCount} doco{o.docoCount === 1 ? "" : "s"}
                              {" · "}
                              {o.nodeCount} node{o.nodeCount === 1 ? "" : "s"}
                              {o.lastUpdatedAt ? (
                                <>
                                  {" · "}
                                  <span title={o.lastUpdatedAt}>{timeAgo(o.lastUpdatedAt)}</span>
                                </>
                              ) : null}
                            </div>
                            {o.description ? (
                              <div className="mt-1 text-sm text-muted-foreground">
                                {o.description}
                              </div>
                            ) : null}
                          </div>
                        </div>
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
                <CardTitle className="text-sm">Your activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Latest activity in your docos</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {feed.length === 0 ? (
                  <p className="px-5 py-6 text-xs text-muted-foreground">No activity yet.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {feed.map((e) => (
                      <OrgsFeedLine key={e.event_id} event={e} />
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

function OrgsFeedLine({ event }: { event: FeedEvent }) {
  const url = entityUrl({
    docoId: event.handle,
    entityType: event.entity_type,
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
