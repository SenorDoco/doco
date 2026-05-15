import { Link, redirect } from "react-router";
import { withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { isMyDoco } from "~/lib/doco-access.server";
import { listDocoStats } from "~/lib/doco-stats.server";
import { listAllDocos, listMyOrgs, loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { timeAgo } from "~/lib/time-ago";
import { SiteHeader } from "~/components/site-header";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

const HEATMAP_WEEKS = 26;
const FEED_LIMIT = 20;

interface FeedEvent {
  event_id: string;
  at: string;
  byUsername: string | null;
  ownerSlug: string;
  docoSlug: string;
  entity_type: string;
  entity_id: string;
  summary: string | null;
  op: string;
}

/**
 * /dashboard — signed-in user's personal home. Three panels:
 *   - Left: Docos the user has a stake in (owner, agent, or org member).
 *   - Top-right: GitHub-style heatmap of the user's own activity
 *     (audit events authored by them OR by an agent they own).
 *   - Bottom-right: chronological feed of recent audit events across
 *     the user's Docos (any actor).
 * Strangers' public Docos remain browseable at /<owner>/<slug>; they
 * do not surface here.
 */
export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");

  const allDocos = await listAllDocos();
  const mine = await Promise.all(
    allDocos.map((d) => isMyDoco({ ownerId: d.ownerId }, me.id)),
  );
  const docos = allDocos.filter((_, i) => mine[i]);
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
        username: string | null;
      }>(
        `SELECT a.event_id, a.at, a.doco_id, a.entity_type, a.entity_id, a.op,
                p.username
         FROM audit_events a
         LEFT JOIN principals p ON p.id = a.by_principal
         WHERE a.doco_id = ANY($1)
         ORDER BY a.at DESC
         LIMIT $2`,
        [myDocoIds, FEED_LIMIT],
      );
      // Look up each event's entity summary so the row reads like the
      // per-Doco FeedLine ("✍️ Decision added: <summary>"). Entity ids
      // are globally unique ULIDs, so one UNION across all node tables
      // resolves them regardless of original type.
      const entityIds = Array.from(new Set(feedRows.rows.map((r) => r.entity_id)));
      const summaryById = new Map<string, string>();
      if (entityIds.length > 0) {
        const summaryRows = await c.query<{ id: string; summary: string | null }>(
          `SELECT id, summary FROM decisions WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM intents WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM ideas WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM rules WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM actions WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM reasoning WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM evals WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM scopes WHERE id = ANY($1)
           UNION ALL SELECT id, summary FROM reference_entities WHERE id = ANY($1)`,
          [entityIds],
        );
        for (const r of summaryRows.rows) {
          if (r.summary != null) summaryById.set(r.id, r.summary);
        }
      }
      const docoMap = new Map(docos.map((d) => [d.docoId, d]));
      feed = feedRows.rows.map((r) => {
        const d = docoMap.get(r.doco_id);
        return {
          event_id: r.event_id,
          at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
          byUsername: r.username,
          ownerSlug: d?.ownerSlug ?? "?",
          docoSlug: d?.docoSlug ?? "?",
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          summary: summaryById.get(r.entity_id) ?? null,
          op: r.op,
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

// Mirror the canonical footer-line vocabulary so dashboard rows read
// the same way agent capture footers do (see capture.server.ts).
function verbFromOp(op: string): string {
  if (op === "entity.create") return "added";
  if (op === "entity.update") return "updated";
  if (op === "entity.delete") return "deleted";
  if (op === "lifecycle.transition") return "transitioned";
  if (op === "edge.add") return "linked";
  return op;
}

function iconFromOp(op: string): string {
  if (op === "entity.create") return "✍️";
  if (op === "entity.update") return "📝";
  if (op === "entity.delete") return "🗑️";
  if (op === "lifecycle.transition") return "🔁";
  if (op === "edge.add") return "➕";
  return "•";
}

function capType(t: string): string {
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
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
        <div className="grid grid-cols-1 gap-4 min-[840px]:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Your docos</CardTitle>
              <CardDescription>
                Docos you own and Docos owned by organizations you belong to. Click to open.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {docos.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  You haven't created or joined any Docos yet.
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
                          <Link
                            to={`/${e.ownerSlug}/${e.docoSlug}`}
                            className="text-primary hover:underline"
                          >
                            {e.ownerSlug}/{e.docoSlug}
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
                  Newest first across every Doco listed on the left.
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
// The Doco link replaces the per-Doco's scopes tail — it's the cross-
// Doco analogue of context. The actor sits behind the Doco link
// because dashboard cuts across principals; per-Doco implies it.
function DashboardFeedLine({ event }: { event: FeedEvent }) {
  const url = entityUrl({
    ownerSlug: event.ownerSlug,
    docoSlug: event.docoSlug,
    nodeType: event.entity_type,
    id: event.entity_id,
  });
  const summary = event.summary ?? `${event.entity_type}_${event.entity_id.slice(-6)}`;
  return (
    <div className="flex items-baseline gap-3 px-5 py-3 font-mono text-xs leading-relaxed text-foreground">
      <div className="min-w-0 flex-1">
        <span>{iconFromOp(event.op)} </span>
        <span className="font-semibold">
          {capType(event.entity_type)} {verbFromOp(event.op)}
        </span>
        <span className="text-muted-foreground">: </span>
        <Link to={url} className="text-primary hover:underline">
          {summary}
        </Link>
        <span className="text-muted-foreground"> — </span>
        <Link
          to={`/${event.ownerSlug}/${event.docoSlug}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {event.ownerSlug}/{event.docoSlug}
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
