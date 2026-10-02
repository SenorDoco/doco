// The three activity logs a workspace or Doco shows, in this order:
//
// - writes: `changesets`, one per version of a node or edge, made by a person
//   on the website or through an agent. Changes to a Doco's settings (its
//   policies) aren't writes: counting a new Doco's template policies would make
//   it look worked on before anyone captured anything. Neither are the
//   changesets an import records: what an integration brought counts once, as
//   imports.
// - queries: `query_events`.
// - imports: every item an integration brought (IMPORTED_ITEMS_SQL).
//
// Two readers: `countByDay` (the Activity calendars) and `summarizeActivity`
// (each log's total over a period, and its top lists: Top contributors and Top
// queryers give one row per person and the agent they worked through, so a
// person who used two agents and the website appears three times; Top
// integrations one row per integration). The pages show the last 7 days of
// top lists; the activity digest email a day's or a week's.

import { TOP_DAYS } from "~/components/top-list";
import { IMPORT, agentName } from "./authoring-provenance";
import { findIntegration } from "./integrations-catalog";

/** Every item an integration brought into a Doco, as (doco_id, integration,
 *  at) rows: from GitHub the files of a codebase and the pull requests and bug
 *  issues it keeps (a pull request's Reference, a bug's Eval), from Slack the
 *  messages of the channels it copies, from Notion the pages fetched so far.
 *  `at` is when it happened in the source where the source says (a message
 *  posted, a page last edited; null when Notion gave no time), else when Doco
 *  last wrote it (a code file, a pull request or bug). */
export const IMPORTED_ITEMS_SQL = `
  SELECT doco_id, 'github' AS integration, synced_at AS at FROM code_files
  UNION ALL
  SELECT doco_id, 'github', updated_at FROM nodes
   WHERE node_type IN ('reference', 'eval')
     AND locator ~ '^https://github\\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+$'
  UNION ALL
  SELECT m.doco_id, 'slack', m.posted_at
    FROM group_chat_messages m
    JOIN group_chat_channels ch USING (doco_id, channel_id)
   WHERE NOT ch.excluded
  UNION ALL
  SELECT doco_id, 'notion', last_edited_time FROM notion_pages WHERE synced_at IS NOT NULL`;

export interface TopActor {
  userId: string;
  username: string;
  /** The agent they worked through, or null for the website itself. */
  via: string | null;
  count: number;
  lastAt: string;
}

export interface TopIntegration {
  /** The integration's id in the catalog: github, slack, notion. */
  integration: string;
  name: string;
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
  imports: Record<string, number>;
}

/** A period's activity: each log's total and its top lists. */
export interface ActivitySummary {
  writes: number;
  queries: number;
  imports: number;
  topContributors: TopActor[];
  topQueryers: TopActor[];
  topIntegrations: TopIntegration[];
}

/** How many rows each list shows on a page. */
export const TOP_LIMIT = 10;

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

const LOGS = {
  writes: `SELECT cs.actor, cs.source, cs.metadata, cs.recorded_at AS at, cs.doco_id,
                  NULL::text AS workspace_id
             FROM changesets cs
            WHERE NOT EXISTS (SELECT 1 FROM node_versions v
                               WHERE v.tx_id = cs.tx_id AND v.entity_type = 'policy')`,
  queries: "SELECT actor, source, metadata, at, doco_id, workspace_id FROM query_events",
} as const;

type PeopleLog = keyof typeof LOGS;

// $1 = the Docos, $2 = the workspace whose cross-Doco searches count, or null.
const IN_SCOPE = "(e.doco_id = ANY($1::text[]) OR (e.doco_id IS NULL AND e.workspace_id = $2))";
const scopeParams = (scope: ActivityScope) => [[...scope.docoIds], scope.workspaceId ?? null];

/** A write the GitHub import recorded rather than a person or their agent. */
const imported = (source: string, metadata: Record<string, unknown> | null) =>
  agentName(source, metadata) === IMPORT;

/** Writes, queries and imports per day since `since`. */
export async function countByDay(
  c: QueryClient,
  scope: ActivityScope,
  since: string,
): Promise<DailyActivity> {
  const perDay = async (log: PeopleLog) => {
    const { rows } = await c.query<{
      day: string;
      source: string;
      metadata: Record<string, unknown> | null;
      n: number;
    }>(
      `SELECT to_char(e.at, 'YYYY-MM-DD') AS day, e.source, e.metadata, COUNT(*)::int AS n
         FROM (${LOGS[log]}) e
        WHERE ${IN_SCOPE} AND e.at >= $3
        GROUP BY day, e.source, e.metadata`,
      [...scopeParams(scope), since],
    );
    const days: Record<string, number> = {};
    for (const r of rows) {
      if (log === "writes" && imported(r.source, r.metadata)) continue;
      days[r.day] = (days[r.day] ?? 0) + r.n;
    }
    return days;
  };
  const { rows } = await c.query<{ day: string; n: number }>(
    `SELECT to_char(at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
       FROM (${IMPORTED_ITEMS_SQL}) i
      WHERE doco_id = ANY($1::text[]) AND at >= $2
      GROUP BY day`,
    [[...scope.docoIds], since],
  );
  return {
    writes: await perDay("writes"),
    queries: await perDay("queries"),
    imports: Object.fromEntries(rows.map((r) => [r.day, r.n])),
  };
}

/** Each log's total from `since` until `until`, and its top `limit` rows. */
export async function summarizeActivity(
  c: QueryClient,
  scope: ActivityScope,
  period: { since: string; until: string },
  limit: number,
): Promise<ActivitySummary> {
  const people = async (log: PeopleLog) => {
    const { rows } = await c.query<{
      user_id: string | null;
      username: string | null;
      source: string;
      metadata: Record<string, unknown> | null;
      n: number;
      last_at: Date | string;
    }>(
      `SELECT u.id AS user_id,
              COALESCE(u.github_login, u.email, u.id) AS username,
              e.source, e.metadata,
              COUNT(*)::int AS n,
              MAX(e.at) AS last_at
         FROM (${LOGS[log]}) e
         LEFT JOIN users u ON u.id = e.actor
        WHERE ${IN_SCOPE} AND e.at >= $3 AND e.at < $4
        GROUP BY u.id, u.github_login, u.email, e.source, e.metadata`,
      [...scopeParams(scope), period.since, period.until],
    );
    let total = 0;
    const byActor = new Map<string, TopActor>();
    for (const r of rows) {
      if (log === "writes" && imported(r.source, r.metadata)) continue;
      total += r.n;
      // A project token or an anonymous reader has no person to list.
      if (!r.user_id || !r.username) continue;
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
    return { total, top: ranked([...byActor.values()], limit) };
  };

  const { rows } = await c.query<{ integration: string; n: number; last_at: Date | string }>(
    `SELECT integration, COUNT(*)::int AS n, MAX(at) AS last_at
       FROM (${IMPORTED_ITEMS_SQL}) i
      WHERE doco_id = ANY($1::text[]) AND at >= $2 AND at < $3
      GROUP BY integration`,
    [[...scope.docoIds], period.since, period.until],
  );
  const integrations = rows.map((r) => ({
    integration: r.integration,
    name: findIntegration(r.integration)?.name ?? r.integration,
    count: r.n,
    lastAt: new Date(r.last_at).toISOString(),
  }));

  const writes = await people("writes");
  const queries = await people("queries");
  return {
    writes: writes.total,
    queries: queries.total,
    imports: integrations.reduce((sum, i) => sum + i.count, 0),
    topContributors: writes.top,
    topQueryers: queries.top,
    topIntegrations: ranked(integrations, limit),
  };
}

/** The last `TOP_DAYS` days' activity, as the pages' top lists show it. */
export async function summarizeLastWeek(
  c: QueryClient,
  scope: ActivityScope,
  now: Date = new Date(),
): Promise<ActivitySummary> {
  const since = new Date(now.getTime() - TOP_DAYS * 86_400_000);
  return summarizeActivity(
    c,
    scope,
    { since: since.toISOString(), until: now.toISOString() },
    TOP_LIMIT,
  );
}

function ranked<T extends { count: number; lastAt: string }>(rows: T[], limit: number): T[] {
  return rows.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}
