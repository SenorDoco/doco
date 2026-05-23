// /dashboard — signed-in welcome page.
//
// Two evenly-split columns:
//   - Header: "Good <verb>, <username>" with +Doco / +Org buttons
//     on the right (desktop)
//   - Left column: nested org/Doco access list and newly available
//     templates
//   - Right column: Activity heatmap + Latest activity feed (10 items)
//     across every doco the user has a stake in

import { withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { Link, redirect } from "react-router";
import { AccessListCard, type AccessListItem } from "~/components/access-list-card";
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
import { listDocoStats } from "~/lib/doco-stats.server";
import { DOCO_TEMPLATES } from "~/lib/doco-templates-meta";
import { pickGreetingVerb } from "~/lib/greeting";
import { listAllDocos, listMyOrgs, loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { timeAgo } from "~/lib/time-ago";

const HEATMAP_WEEKS = 52;
const FEED_LIMIT = 10;
const TEMPLATES_LIMIT = 5;
const TEMPLATE_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

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
  if (!me) throw redirect("/sign-in");

  const allDocos = await listAllDocos();
  const invitedDocoIds = await listInvitedDocoIdsForPrincipal(me.id);
  const mine = await Promise.all(allDocos.map((d) => isMyDoco({ ownerId: d.ownerId }, me.id)));
  const docos = allDocos.filter((d, i) => mine[i] || invitedDocoIds.has(d.docoId));
  const myDocoIds = docos.map((d) => d.docoId);

  const [docoStats, orgsRaw] = await Promise.all([listDocoStats(myDocoIds), listMyOrgs(me.id)]);

  const accessGroupsByOwner = new Map<string, AccessListItem>();
  for (const org of orgsRaw) {
    accessGroupsByOwner.set(org.id, {
      id: org.id,
      href: `/orgs/${org.handle}`,
      label: org.display_name || org.handle,
      count: 0,
      lastUpdatedAt: null,
      children: [],
    });
  }

  for (const d of docos) {
    const stats = docoStats.get(d.docoId);
    const row: AccessListItem = {
      id: d.docoId,
      href: `/${d.handle}`,
      label: d.handle,
      count: stats?.neurons ?? 0,
      lastUpdatedAt: stats?.lastUpdatedAt ?? null,
    };

    let group = accessGroupsByOwner.get(d.ownerId);
    if (!group) {
      group = {
        id: d.ownerId,
        href: d.ownerKind === "organization" ? `/orgs/${d.ownerUsername}` : `/${d.ownerUsername}`,
        label: d.ownerId === me.id ? "Personal" : d.ownerUsername,
        count: 0,
        lastUpdatedAt: null,
        children: [],
      };
      accessGroupsByOwner.set(d.ownerId, group);
    }

    group.children?.push(row);
    group.count += row.count;
    group.lastUpdatedAt = newestIso(group.lastUpdatedAt, row.lastUpdatedAt);
  }

  const accessGroups = Array.from(accessGroupsByOwner.values())
    .map((group) => ({
      ...group,
      children: (group.children ?? []).sort(sortAccessItems),
    }))
    .sort(sortAccessItems);

  const since = new Date();
  since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
  const sinceIso = since.toISOString();

  const { byDay, feed } = await withClient(async (c) => {
    const heatRows = await c.query<{ day: string; n: string }>(
      `SELECT to_char(at, 'YYYY-MM-DD') AS day, COUNT(*)::text AS n
       FROM audit_events
       WHERE by_collaborator = $1
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
        principal_name: string | null;
      }>(
        `SELECT a.event_id, a.at, a.doco_id, a.entity_type, a.entity_id, a.op,
                a.before_json, a.after_json,
                p.name AS principal_name
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
          `SELECT id, split_part(decision, E'\n', 1) AS label, lifecycle FROM decisions WHERE id = ANY($1)
           UNION ALL SELECT id, split_part(intent, E'\n', 1) AS label, lifecycle FROM intents WHERE id = ANY($1)
           UNION ALL SELECT id, split_part(idea, E'\n', 1) AS label, lifecycle FROM ideas WHERE id = ANY($1)
           UNION ALL SELECT id, split_part(rule, E'\n', 1) AS label, lifecycle FROM rules WHERE id = ANY($1)
           UNION ALL SELECT id, split_part(action, E'\n', 1) AS label, lifecycle FROM actions WHERE id = ANY($1)
           UNION ALL SELECT id, split_part(log, E'\n', 1) AS label, lifecycle FROM logs WHERE id = ANY($1)
           UNION ALL SELECT id, split_part(eval, E'\n', 1) AS label, lifecycle FROM evals WHERE id = ANY($1)
           UNION ALL SELECT id, split_part(reference, E'\n', 1) AS label, lifecycle FROM reference_entities WHERE id = ANY($1)`,
          [entityIds],
        );
        for (const r of entityLabelRows.rows) {
          entityById.set(r.id, { label: r.label, lifecycle: r.lifecycle });
        }
      }
      const docoMap = new Map(docos.map((d) => [d.docoId, d]));
      feed = feedRows.rows.map((r) => {
        const d = docoMap.get(r.doco_id);
        const entity = entityById.get(r.entity_id);
        return {
          event_id: r.event_id,
          at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
          byUsername: r.principal_name,
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

  // Newly-available templates, most recent first. Drops "generic" —
  // it's not really a "template", it's the no-op starting point.
  const templates = DOCO_TEMPLATES.filter((t) => t.handle !== "generic")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, TEMPLATES_LIMIT);

  return {
    host: await loadHostConfig(),
    me,
    greetingVerb: pickGreetingVerb(),
    accessGroups,
    byDay,
    feed,
    templates,
  };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Dashboard · Doco" }];
  return [{ title: `${data.host.name} · Doco` }];
}

export default function Dashboard({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, greetingVerb, accessGroups, byDay, feed, templates } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-6">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Dashboard" })} />
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">
            Good {greetingVerb}, {me.username}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/new-doco"
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-3 py-1.5 text-sm font-semibold"
            >
              + Doco
            </Link>
            <Link
              to="/new-org"
              className="neu-button rounded-md px-3 py-1.5 text-sm font-semibold text-foreground"
            >
              + Org
            </Link>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 min-[840px]:grid-cols-2">
          <section className="space-y-4">
            <AccessListCard
              title="Your orgs and docos"
              items={accessGroups}
              empty="No orgs or docos yet."
            />

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Newly available templates</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                {templates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No templates available.</p>
                ) : (
                  templates.map((t) => (
                    <div key={t.handle} className="space-y-1.5 pb-3 last:pb-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                        <span className="text-sm font-semibold">{t.label}</span>
                        <time
                          dateTime={t.updatedAt}
                          title={t.updatedAt}
                          className="shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
                        >
                          Last updated {formatTemplateUpdatedAt(t.updatedAt)}
                        </time>
                      </div>
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        {t.description}
                      </p>
                      <div className="flex items-center justify-between gap-2 pt-0.5">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          by {t.owner}
                        </span>
                        <Link
                          to={`/new-doco?template_handle=${encodeURIComponent(t.handle)}`}
                          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2 py-1 text-[11px] font-semibold"
                        >
                          + Doco
                        </Link>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </section>

          <aside className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Your activity matrix</CardTitle>
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
                      <DashboardFeedLine key={e.event_id} event={e} />
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

function newestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

function sortAccessItems(
  a: { label: string; lastUpdatedAt: string | null },
  b: { label: string; lastUpdatedAt: string | null },
): number {
  if (a.lastUpdatedAt && b.lastUpdatedAt) return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
  if (a.lastUpdatedAt) return -1;
  if (b.lastUpdatedAt) return 1;
  return a.label.localeCompare(b.label);
}

function formatTemplateUpdatedAt(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;

  const [, year, month, day] = match;
  return TEMPLATE_DATE_FORMATTER.format(
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
  );
}

// Mirrors the per-Doco FeedLine shape so both surfaces read the same:
//   <op-icon> <Type> <verb>: <summary> — <owner>/<doco> · <by>      Ns ago
// The Doco link gives cross-Doco context. The actor sits behind the
// Doco link because dashboard cuts across principals; per-Doco implies
// it.
function DashboardFeedLine({ event }: { event: FeedEvent }) {
  const url = entityUrl({
    docoHandle: event.handle,
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
