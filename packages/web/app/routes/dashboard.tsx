// /dashboard — signed-in welcome page.
//
// Two evenly-split columns:
//   - Header: "Good <verb>, <username>" with +Doco / +Org buttons
//     on the right (desktop)
//   - Left column: one-click org/Doco access rows and newly available
//     templates
//   - Right column: Activity heatmap + Latest activity feed (10 items)
//     across every doco the user has a stake in

import { withClient } from "@doco/db";
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
import { ENTITY_TABLES, listDocoStats } from "~/lib/doco-stats.server";
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

interface AccessRow {
  id: string;
  href: string;
  label: string;
  eyebrow: string;
  activeNodes: number;
  totalNodes: number;
  lastUpdatedAt: string | null;
}

interface NodeActivityStats {
  activeNodes: number;
  totalNodes: number;
  lastUpdatedAt: string | null;
}

const EMPTY_NODE_ACTIVITY: NodeActivityStats = {
  activeNodes: 0,
  totalNodes: 0,
  lastUpdatedAt: null,
};

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");

  const allDocos = await listAllDocos();
  const invitedDocoIds = await listInvitedDocoIdsForPrincipal(me.id);
  const mine = await Promise.all(allDocos.map((d) => isMyDoco({ ownerId: d.ownerId }, me.id)));
  const docos = allDocos.filter((d, i) => mine[i] || invitedDocoIds.has(d.docoId));
  const myDocoIds = docos.map((d) => d.docoId);

  const [docoStats, orgsRaw] = await Promise.all([listDocoStats(myDocoIds), listMyOrgs(me.id)]);
  const orgStats = await listOrgActivityStats(orgsRaw.map((o) => o.id));

  const orgs: AccessRow[] = orgsRaw
    .map((o) => {
      const stats = orgStats.get(o.id) ?? EMPTY_NODE_ACTIVITY;
      return {
        id: o.id,
        href: `/orgs/${o.slug}`,
        label: o.display_name || o.slug,
        eyebrow: `Org · ${o.slug}`,
        activeNodes: stats.activeNodes,
        totalNodes: stats.totalNodes,
        lastUpdatedAt: stats.lastUpdatedAt,
      };
    })
    .sort(sortAccessRows);

  const docoRows: AccessRow[] = docos
    .map((d) => {
      const stats = docoStats.get(d.docoId);
      return {
        id: d.docoId,
        href: `/${d.handle}`,
        label: d.handle,
        eyebrow: `Doco · ${d.ownerUsername}`,
        activeNodes: stats?.activeNeurons ?? 0,
        totalNodes: stats?.neurons ?? 0,
        lastUpdatedAt: stats?.lastUpdatedAt ?? null,
      };
    })
    .sort(sortAccessRows);

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
        username: string | null;
      }>(
        `SELECT a.event_id, a.at, a.doco_id, a.entity_type, a.entity_id, a.op,
                a.before_json, a.after_json,
                p.username
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
      const docoMap = new Map(docos.map((d) => [d.docoId, d]));
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

  // Newly-available templates, most recent first. Drops "generic" —
  // it's not really a "template", it's the no-op starting point.
  const templates = DOCO_TEMPLATES.filter((t) => t.handle !== "generic")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, TEMPLATES_LIMIT);

  return {
    host: await loadHostConfig(),
    me,
    greetingVerb: pickGreetingVerb(),
    orgs,
    docos: docoRows,
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
  const { me, greetingVerb, orgs, docos, byDay, feed, templates } = loaderData;
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
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              + Doco
            </Link>
            <Link
              to="/new-org"
              className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-input"
            >
              + Org
            </Link>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 min-[840px]:grid-cols-2">
          <section className="space-y-4">
            <AccessListCard title="Your orgs" rows={orgs} emptyLabel="No orgs yet." />
            <AccessListCard title="Your Docos" rows={docos} emptyLabel="No Docos yet." />

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Newly available templates</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                {templates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No templates available.</p>
                ) : (
                  templates.map((t) => (
                    <div
                      key={t.handle}
                      className="space-y-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0"
                    >
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
                          className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90"
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
                <CardTitle className="text-sm">Latest activity in your Docos</CardTitle>
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

async function listOrgActivityStats(
  orgIds: readonly string[],
): Promise<Map<string, NodeActivityStats>> {
  const out = new Map<string, NodeActivityStats>();
  for (const id of orgIds) out.set(id, { ...EMPTY_NODE_ACTIVITY });
  if (orgIds.length === 0) return out;

  const nodesUnionSql = ENTITY_TABLES.map((t) => `SELECT doco_id, lifecycle FROM ${t}`).join(
    " UNION ALL ",
  );

  return withClient(async (c) => {
    const [nodeRows, updatedRows] = await Promise.all([
      c.query<{ owner_id: string; total_nodes: string; active_nodes: string }>(
        `SELECT d.owner_id,
                COUNT(*)::text AS total_nodes,
                COUNT(*) FILTER (WHERE COALESCE(t.lifecycle, 'active') = 'active')::text AS active_nodes
           FROM (${nodesUnionSql}) t
           JOIN docos d ON d.id = t.doco_id
          WHERE d.owner_id = ANY($1)
          GROUP BY d.owner_id`,
        [[...orgIds]],
      ),
      c.query<{ owner_id: string; last_at: string | null }>(
        `SELECT d.owner_id, MAX(a.at)::text AS last_at
           FROM audit_events a
           JOIN docos d ON d.id = a.doco_id
          WHERE d.owner_id = ANY($1)
          GROUP BY d.owner_id`,
        [[...orgIds]],
      ),
    ]);

    for (const row of nodeRows.rows) {
      const stats = out.get(row.owner_id);
      if (stats) {
        stats.activeNodes = Number(row.active_nodes);
        stats.totalNodes = Number(row.total_nodes);
      }
    }
    for (const row of updatedRows.rows) {
      const stats = out.get(row.owner_id);
      if (stats) stats.lastUpdatedAt = row.last_at;
    }
    return out;
  });
}

function sortAccessRows(a: AccessRow, b: AccessRow): number {
  if (a.lastUpdatedAt && b.lastUpdatedAt) return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
  if (a.lastUpdatedAt) return -1;
  if (b.lastUpdatedAt) return 1;
  return a.label.localeCompare(b.label);
}

function AccessListCard({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows: AccessRow[];
  emptyLabel: string;
}) {
  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id}>
                <Link to={row.href} className="block px-4 py-3 hover:bg-input">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-primary">{row.label}</div>
                      <div className="mt-0.5 truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                        {row.eyebrow}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm tabular-nums text-foreground">
                        {row.activeNodes}/{row.totalNodes}
                      </div>
                      <div className="text-[11px] text-muted-foreground">active nodes</div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Last modified{" "}
                    {row.lastUpdatedAt ? (
                      <time
                        dateTime={row.lastUpdatedAt}
                        title={row.lastUpdatedAt}
                        suppressHydrationWarning
                      >
                        {timeAgo(row.lastUpdatedAt)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
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
