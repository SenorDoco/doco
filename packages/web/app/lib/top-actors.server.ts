// Top contributors and Top queryers: who wrote to (or queried) a set of Docos
// most, as one row per person and the agent they worked through, so a person
// who used two agents and the website appears three times. Writes come from
// `changesets`, queries from `query_events`; both carry the request context
// `agentName` reads, and rows whose context names the same agent merge.

import { agentName } from "./authoring-provenance";

export interface TopActor {
  userId: string;
  username: string;
  /** The agent they worked through, or null for the website itself. */
  via: string | null;
  count: number;
  lastAt: string;
}

export interface TopActorScope {
  docoIds: readonly string[];
  /** Also count this workspace's searches across all its Docos. */
  workspaceId?: string;
}

/** How many rows each list shows. */
export const TOP_ACTORS_LIMIT = 10;

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

const LOGS = {
  writes:
    "SELECT actor, source, metadata, recorded_at AS at, doco_id, NULL::text AS workspace_id FROM changesets",
  queries: "SELECT actor, source, metadata, at, doco_id, workspace_id FROM query_events",
} as const;

export async function listTopActors(
  c: QueryClient,
  log: keyof typeof LOGS,
  scope: TopActorScope,
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
      WHERE e.doco_id = ANY($1::text[])
         OR (e.doco_id IS NULL AND e.workspace_id = $2)
      GROUP BY e.actor, u.github_login, u.email, u.id, e.source, e.metadata`,
    [[...scope.docoIds], scope.workspaceId ?? null],
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
