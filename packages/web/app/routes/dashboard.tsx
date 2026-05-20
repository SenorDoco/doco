import { withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { Link, redirect } from "react-router";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
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
import { isMyDoco, listInvitedDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { listDocoStats } from "~/lib/doco-stats.server";
import { listAllDocos, listMyOrgs, loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { timeAgo } from "~/lib/time-ago";

const HEATMAP_WEEKS = 52;
const FEED_LIMIT = 20;

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

/**
 * /dashboard — signed-in user's personal home. Three panels:
 *   - Left: docos the user has a stake in (owner, agent, or org member).
 *   - Top-right: GitHub-style heatmap of the user's own activity
 *     (audit events authored by them OR by an agent they own).
 *   - Bottom-right: chronological feed of recent audit events across
 *     the user's docos (any actor).
 * Strangers' public docos remain browseable at /<owner>/<slug>; they
 * do not surface here.
 */
export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");

  const allDocos = await listAllDocos();
  const invitedDocoIds = await listInvitedDocoIdsForPrincipal(me.id);
  const mine = await Promise.all(allDocos.map((d) => isMyDoco({ ownerId: d.ownerId }, me.id)));
  const docos = allDocos.filter((d, i) => mine[i] || invitedDocoIds.has(d.docoId));
  const myDocoIds = docos.map((d) => d.docoId);
  const docoStats = await listDocoStats(myDocoIds);

  const myOrgs = await listMyOrgs(me.id);

  const since = new Date();
  since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
  const sinceIso = since.toISOString();

  const { byDay, feed } = await withClient(async (c) => {
    const heatRows = await c.query<{ day: string; n: string }>(
      `SELECT to_char(at, 'YYYY-MM-DD') AS day, COUNT(*)::text AS n
       FROM audit_events
       WHERE (by_principal = $1
              OR by_principal IN (SELECT id FROM principals WHERE owner_id = $1))
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
         LEFT JOIN principals p ON p.id = a.by_principal
         WHERE a.doco_id = ANY($1)
         ORDER BY a.at DESC
         LIMIT $2`,
        [myDocoIds, FEED_LIMIT],
      );
      // Look up each event's readable label so the row reads like the
      // per-Doco FeedLine ("✍️ Decision added: <readable text>"). Entity ids
      // are globally unique ULIDs, so one UNION across all node tables
      // resolves them regardless of original type.
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
           UNION ALL SELECT id, summary AS label, lifecycle FROM states WHERE id = ANY($1)
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

  const docosWithStats = docos.map((d) => ({
    ...d,
    stats: docoStats.get(d.docoId) ?? { nodes: 0, edges: 0, lastUpdatedAt: null },
  }));

  return {
    host: await loadHostConfig(),
    me,
    docos: docosWithStats,
    myOrgs,
    byDay,
    feed,
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
  const { me, docos, myOrgs, byDay, feed } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Docos</h1>
            <p className="text-sm text-muted-foreground">
              Your docos, plus docos owned by organizations you belong to.
            </p>
          </div>
          <Link
            to="/onboarding/create/human"
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            + Doco
          </Link>
        </header>

        <div className="grid grid-cols-1 gap-4 min-[840px]:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Your docos</CardTitle>
            </CardHeader>
            <CardContent>
              {docos.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  You haven't created or joined any docos yet.{" "}
                  <Link to="/onboarding/create/human" className="underline">
                    Create one
                  </Link>
                  .
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>slug</TableHead>
                      <TableHead className="text-right">nodes</TableHead>
                      <TableHead className="text-right">edges</TableHead>
                      <TableHead className="text-right">last updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {docos.map((e) => (
                      <TableRow key={e.docoId}>
                        <TableCell>
                          <Link to={`/${e.handle}`} className="text-primary hover:underline">
                            {e.handle}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-mono">{e.stats.nodes}</TableCell>
                        <TableCell className="text-right font-mono">{e.stats.edges}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {timeAgo(e.stats.lastUpdatedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Your activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Latest activity in your docos</CardTitle>
                <CardDescription>
                  Newest first across every doco listed on the left.
                </CardDescription>
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
          </div>
        </div>

        {myOrgs.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Your organizations ({myOrgs.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {myOrgs.map((o) => (
                  <li key={o.id} className="flex items-baseline gap-2">
                    <Badge variant="accent">{o.slug}</Badge>
                    <span className="text-muted-foreground text-xs">
                      {o.member_count} member(s)
                      {o.description ? ` · ${o.description}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </main>
    </div>
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
