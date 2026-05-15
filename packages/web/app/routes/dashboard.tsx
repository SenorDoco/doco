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

function verbFromOp(op: string): string {
  if (op === "entity.create") return "created";
  if (op === "entity.update") return "updated";
  if (op === "entity.delete") return "deleted";
  if (op === "lifecycle.transition") return "transitioned";
  if (op === "edge.add") return "linked";
  return op;
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Your Docos ({docos.length})</CardTitle>
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
                <CardDescription>
                  Audit events you authored, last {HEATMAP_WEEKS} weeks.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Latest activity in your Docos</CardTitle>
                <CardDescription>
                  Newest first across every Doco listed on the left.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {feed.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No activity yet.</p>
                ) : (
                  <ol className="space-y-2 text-xs">
                    {feed.map((e) => (
                      <li key={e.event_id} className="border-l-2 border-border pl-3">
                        <div className="text-muted-foreground">
                          <code className="font-mono">
                            {e.at.replace("T", " ").slice(0, 16)}Z
                          </code>
                          <span className="mx-2">·</span>
                          <span className="font-medium text-foreground">
                            {e.byUsername ?? "anonymous"}
                          </span>{" "}
                          {verbFromOp(e.op)}{" "}
                          <Link
                            to={entityUrl({
                              ownerSlug: e.ownerSlug,
                              docoSlug: e.docoSlug,
                              nodeType: e.entity_type,
                              id: e.entity_id,
                            })}
                            className="text-primary hover:underline"
                          >
                            {e.entity_type}
                          </Link>
                          <span className="mx-2">·</span>
                          <Link
                            to={`/${e.ownerSlug}/${e.docoSlug}`}
                            className="hover:underline"
                          >
                            {e.ownerSlug}/{e.docoSlug}
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ol>
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
