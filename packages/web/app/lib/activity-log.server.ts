// The two activity logs a workspace or Doco shows: writes (`changesets`, one
// per version of a node or edge) and queries (`query_events`). Both carry the
// request context `agentName` reads. Changes to a Doco's settings (its
// policies) aren't writes: counting a new Doco's template policies would make
// it look worked on before anyone captured anything.
//
// Two readers: `listTopActors` (Top contributors and Top queryers, one row per
// person and the agent they worked through, so a person who used two agents
// and the website appears three times) and `countByDay` (the Activity
// calendars).

import { agentName } from "./authoring-provenance";
import { copiesByDay } from "./doco-stats.server";

export interface TopActor {
  userId: string;
  username: string;
  /** The agent they worked through, or null for the website itself. */
  via: string | null;
  count: number;
  lastAt: string;
}

export interface ActivityScope {
  docoIds: readonly string[];
  /** Also count this workspace's searches across all its Docos. */
  workspaceId?: string;
}

/** Each log's count per day, keyed by YYYY-MM-DD. */
export interface DailyActivity {
  writes: Record<string, number>;
  queries: Record<string, number>;
}

/** How many rows each list shows. */
export const TOP_ACTORS_LIMIT = 10;

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

const LOGS = {
  writes: `SELECT cs.actor, cs.source, cs.metadata, cs.recorded_at AS at, cs.doco_id,
                  NULL::text AS workspace_id
             FROM changesets cs
            WHERE NOT EXISTS (SELECT 1 FROM node_versions v
                               WHERE v.tx_id = cs.tx_id AND v.entity_type = 'policy')`,
  queries: "SELECT actor, source, metadata, at, doco_id, workspace_id FROM query_events",
} as const;

type Log = keyof typeof LOGS;

// $1 = the Docos, $2 = the workspace whose cross-Doco searches count, or null.
const IN_SCOPE = "(e.doco_id = ANY($1::text[]) OR (e.doco_id IS NULL AND e.workspace_id = $2))";
const scopeParams = (scope: ActivityScope) => [[...scope.docoIds], scope.workspaceId ?? null];

export async function listTopActors(
  c: QueryClient,
  log: Log,
  scope: ActivityScope,
  limit: number,
): Promise<TopActor[]> {
  const { rows } = await c.query<{
    user_id: string;
    username: string;
    source: string;
    metadata: Record<string, unknown> | null;
    n: number;
    last_at: Date | string;
  }>(
    `SELECT e.actor AS user_id,
            COALESCE(u.github_login, u.email, u.id) AS username,
            e.source, e.metadata,
            COUNT(*)::int AS n,
            MAX(e.at) AS last_at
       FROM (${LOGS[log]}) e
       JOIN users u ON u.id = e.actor
      WHERE ${IN_SCOPE}
      GROUP BY e.actor, u.github_login, u.email, u.id, e.source, e.metadata`,
    scopeParams(scope),
  );

  const byActor = new Map<string, TopActor>();
  for (const r of rows) {
    const via = agentName(r.source, r.metadata);
    const lastAt = new Date(r.last_at).toISOString();
    const key = JSON.stringify([r.user_id, via]);
    const seen = byActor.get(key);
    if (seen) {
      seen.count += r.n;
      if (lastAt > seen.lastAt) seen.lastAt = lastAt;
    } else {
      byActor.set(key, { userId: r.user_id, username: r.username, via, count: r.n, lastAt });
    }
  }
  return [...byActor.values()]
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}

/** Writes and queries per day since `since`. What a Doco copied from its
 *  source (Slack messages, Notion pages, code files) counts as writes. */
export async function countByDay(
  c: QueryClient,
  scope: ActivityScope,
  since: string,
): Promise<DailyActivity> {
  const perDay = async (log: Log) => {
    const { rows } = await c.query<{ day: string; n: number }>(
      `SELECT to_char(e.at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
         FROM (${LOGS[log]}) e
        WHERE ${IN_SCOPE} AND e.at >= $3
        GROUP BY day`,
      [...scopeParams(scope), since],
    );
    return Object.fromEntries(rows.map((r) => [r.day, r.n]));
  };
  const writes = await copiesByDay(c, scope.docoIds, since);
  for (const [day, n] of Object.entries(await perDay("writes"))) {
    writes[day] = (writes[day] ?? 0) + n;
  }
  return { writes, queries: await perDay("queries") };
}
