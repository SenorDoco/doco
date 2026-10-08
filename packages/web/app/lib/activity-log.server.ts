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
//
// Both read the whole days `rollUpActivity` counted into activity_days, and
// the rest of their period (its partial first day, and the days since the
// last run, normally just today) from the logs, so neither reads every row of
// a year on every view, and a write shows the moment it is made
// (decision_01M4CEZ46KVA415131Z0BQZ2SC).

import { TOP_DAYS } from "~/components/top-list";
import { IMPORT, agentName, mechanismMetadataSql } from "./authoring-provenance";
import { findIntegration } from "./integrations-catalog";

/** Every table an integration fills, as `i`: from GitHub the files of a
 *  codebase and the pull requests and bug issues it keeps (a pull request's
 *  Reference, a bug's Eval), from Slack the messages of the channels it copies,
 *  from Notion the pages fetched so far. `at` is when an item happened in the
 *  source where the source says (a message posted, a page last edited; null
 *  when Notion gave no time), else when Doco last wrote it (a code file, a pull
 *  request or bug). Each has an index on (doco_id, at) in schema.sql, with
 *  `where` as the predicate of a partial one. */
const IMPORT_SOURCES = [
  { integration: "github", table: "code_files", at: "synced_at", where: "true" },
  {
    integration: "github",
    table: "nodes",
    at: "updated_at",
    where: `i.node_type IN ('reference', 'eval')
            AND i.locator ~ '^https://github\\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+$'`,
  },
  {
    integration: "slack",
    table: "group_chat_messages",
    at: "posted_at",
    where: `NOT EXISTS (SELECT 1 FROM group_chat_channels ch
                         WHERE ch.doco_id = i.doco_id AND ch.channel_id = i.channel_id
                           AND ch.excluded)`,
  },
  {
    integration: "notion",
    table: "notion_pages",
    at: "last_edited_time",
    where: "i.synced_at IS NOT NULL",
  },
] as const;

/** Every item an integration brought into a Doco, as (doco_id, integration,
 *  at) rows. */
export const IMPORTED_ITEMS_SQL = IMPORT_SOURCES.map(
  (s) =>
    `SELECT i.doco_id, '${s.integration}' AS integration, i.${s.at} AS at FROM ${s.table} i WHERE ${s.where}`,
).join("\n  UNION ALL\n  ");

/**
 * When each Doco last saw activity: the latest change to its content (an audit
 * event; policies are settings, not activity) or item an integration brought
 * (`integration` keeps to one). One newest-row probe per source and Doco, on
 * its (doco_id, at) index, so it costs the same however much a Doco holds.
 * Docos with none are left out.
 */
export async function loadLatestActivity(
  c: QueryClient,
  docoIds: readonly string[],
  opts: { integration?: string } = {},
): Promise<Map<string, string>> {
  const newest = (table: string, at: string, where: string) =>
    `(SELECT i.${at} FROM ${table} i
       WHERE i.doco_id = d.id AND i.${at} IS NOT NULL AND ${where}
       ORDER BY i.${at} DESC LIMIT 1)`;
  const probes = [
    ...(opts.integration ? [] : [newest("audit_events", "at", "i.entity_type <> 'policy'")]),
    ...IMPORT_SOURCES.filter((s) => !opts.integration || s.integration === opts.integration).map(
      (s) => newest(s.table, s.at, s.where),
    ),
  ];
  const { rows } = await c.query<{ doco_id: string; at: Date | string }>(
    `SELECT d.id AS doco_id, GREATEST(${probes.join(",\n")}) AS at
       FROM unnest($1::text[]) AS d(id)`,
    [[...docoIds]],
  );
  return new Map(
    rows.filter((r) => r.at !== null).map((r) => [r.doco_id, new Date(r.at).toISOString()]),
  );
}

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

type Log = keyof DailyActivity;

/** Each log's rows, as (doco_id, workspace_id, actor, source, metadata, at);
 *  an import's source is its integration. */
const LOGS: Record<Log, string> = {
  writes: `SELECT cs.doco_id, NULL::text AS workspace_id, cs.actor, cs.source, cs.metadata,
                  cs.recorded_at AS at
             FROM changesets cs
            WHERE NOT EXISTS (SELECT 1 FROM node_versions v
                               WHERE v.tx_id = cs.tx_id AND v.entity_type = 'policy')`,
  queries: "SELECT doco_id, workspace_id, actor, source, metadata, at FROM query_events",
  imports: `SELECT doco_id, NULL::text AS workspace_id, NULL::text AS actor,
                   integration AS source, NULL::jsonb AS metadata, at
              FROM (${IMPORTED_ITEMS_SQL}) i`,
};

/** A log's count for one UTC day, Doco (or workspace), person, and the agent
 *  they worked through (null for the website) or, for imports, the
 *  integration: a row of activity_days. */
interface Tally {
  log: Log;
  day: string;
  docoId: string | null;
  workspaceId: string | null;
  actor: string | null;
  via: string | null;
  n: number;
  lastAt: string;
}

/** From `since` until just before `until`; open where either is left out. */
interface Span {
  since?: string;
  until?: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const iso = (at: Date | string | number) => new Date(at).toISOString();
const isoDay = (at: number) => iso(at).slice(0, 10);

// $1 = the Docos, $2 = the workspace whose cross-Doco searches count, or null.
const IN_SCOPE = "(e.doco_id = ANY($1::text[]) OR (e.doco_id IS NULL AND e.workspace_id = $2))";
const scopeParams = (scope: ActivityScope) => [[...scope.docoIds], scope.workspaceId ?? null];

/** Count `logs` over `span` from the logs themselves, in `scope`, or everywhere
 *  when it's null. */
async function countLogs(
  c: QueryClient,
  logs: readonly Log[],
  scope: ActivityScope | null,
  span: Span,
): Promise<Tally[]> {
  const params: unknown[] = scope ? scopeParams(scope) : [];
  const at = (op: string, value: string) => {
    params.push(value);
    return `e.at ${op} $${params.length}`;
  };
  const where = [
    "e.at IS NOT NULL",
    ...(scope ? [IN_SCOPE] : []),
    ...(span.since ? [at(">=", span.since)] : []),
    ...(span.until ? [at("<", span.until)] : []),
  ].join(" AND ");
  const tallies: Tally[] = [];
  for (const log of logs) {
    const { rows } = await c.query<{
      day: string;
      doco_id: string | null;
      workspace_id: string | null;
      actor: string | null;
      source: string;
      how: Record<string, unknown>;
      n: number;
      last_at: Date | string;
    }>(
      `SELECT to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, e.doco_id, e.workspace_id,
              e.actor, e.source, ${mechanismMetadataSql("e")} AS how,
              COUNT(*)::int AS n, MAX(e.at) AS last_at
         FROM (${LOGS[log]}) e
        WHERE ${where}
        GROUP BY day, e.doco_id, e.workspace_id, e.actor, e.source, how`,
      params,
    );
    for (const r of rows) {
      const via = log === "imports" ? r.source : agentName(r.source, r.how);
      // A write the GitHub import recorded counts once, as an import.
      if (log === "writes" && via === IMPORT) continue;
      tallies.push({
        log,
        day: r.day,
        docoId: r.doco_id,
        workspaceId: r.workspace_id,
        actor: r.actor,
        via,
        n: r.n,
        lastAt: iso(r.last_at),
      });
    }
  }
  return tallies;
}

/** Every log's count over `period` in `scope`: the whole days the rollup
 *  counted from activity_days, the rest from the logs. */
async function countActivity(
  c: QueryClient,
  scope: ActivityScope,
  period: Span & { since: string },
): Promise<Tally[]> {
  const since = Date.parse(period.since);
  const until = period.until ? Date.parse(period.until) : Number.POSITIVE_INFINITY;
  const through = await rolledThrough(c);
  // The period's whole days the rollup counted, as [from, to).
  const from = Math.ceil(since / DAY_MS) * DAY_MS;
  const to = through
    ? Math.min(Date.parse(through) + DAY_MS, Math.floor(until / DAY_MS) * DAY_MS)
    : from;
  if (to <= from) return countLogs(c, ["writes", "queries", "imports"], scope, period);

  const { rows } = await c.query<{
    log: Log;
    day: string;
    actor: string | null;
    via: string | null;
    n: number;
    last_at: Date | string;
  }>(
    `SELECT e.log, to_char(e.day, 'YYYY-MM-DD') AS day, e.actor, e.via,
            SUM(e.n)::int AS n, MAX(e.last_at) AS last_at
       FROM activity_days e
      WHERE ${IN_SCOPE} AND e.day >= $3 AND e.day < $4
      GROUP BY e.log, e.day, e.actor, e.via`,
    [...scopeParams(scope), isoDay(from), isoDay(to)],
  );
  const tallies: Tally[] = rows.map((r) => ({
    log: r.log,
    day: r.day,
    docoId: null,
    workspaceId: null,
    actor: r.actor,
    via: r.via,
    n: r.n,
    lastAt: iso(r.last_at),
  }));
  const rest: Span[] = [
    ...(since < from ? [{ since: period.since, until: iso(from) }] : []),
    ...(to < until ? [{ since: iso(to), until: period.until }] : []),
  ];
  for (const span of rest) {
    tallies.push(...(await countLogs(c, ["writes", "queries", "imports"], scope, span)));
  }
  return tallies;
}

/** The last day the rollup counted, as YYYY-MM-DD, or null before its first run. */
async function rolledThrough(c: QueryClient): Promise<string | null> {
  const { rows } = await c.query<{ through: string }>(
    "SELECT to_char(through, 'YYYY-MM-DD') AS through FROM activity_rollup",
  );
  return rows[0]?.through ?? null;
}

/**
 * Count the logs into activity_days (see schema.sql) for the days that have
 * ended: each day of writes and queries once, an hour after it ends (a write
 * is dated when its transaction began, so one open at midnight lands in the
 * day before), and every day of imports again, since they change in place
 * and arrive dated in the past. The first run counts all history. Run it in a
 * transaction: a second run waits for the first.
 */
export async function rollUpActivity(
  c: QueryClient,
  now: Date = new Date(),
): Promise<{ through: string }> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('activity_rollup'))");
  const last = await rolledThrough(c);
  const lastEnd = last ? Date.parse(last) + DAY_MS : null;
  const end = Math.floor((now.getTime() - HOUR_MS) / DAY_MS) * DAY_MS;
  const until = Math.max(end, lastEnd ?? end);
  const tallies = [
    ...(lastEnd === until
      ? []
      : await countLogs(c, ["writes", "queries"], null, {
          since: lastEnd === null ? undefined : iso(lastEnd),
          until: iso(until),
        })),
    ...(await countLogs(c, ["imports"], null, { until: iso(until) })),
  ];
  await c.query("DELETE FROM activity_days WHERE log = 'imports'");
  await c.query(
    `INSERT INTO activity_days (day, log, doco_id, workspace_id, actor, via, n, last_at)
     SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::text[],
                          $6::text[], $7::int[], $8::timestamptz[])`,
    [
      tallies.map((t) => t.day),
      tallies.map((t) => t.log),
      tallies.map((t) => t.docoId),
      tallies.map((t) => t.workspaceId),
      tallies.map((t) => t.actor),
      tallies.map((t) => t.via),
      tallies.map((t) => t.n),
      tallies.map((t) => t.lastAt),
    ],
  );
  const through = isoDay(until - DAY_MS);
  await c.query(
    `INSERT INTO activity_rollup (through) VALUES ($1)
     ON CONFLICT (one) DO UPDATE SET through = EXCLUDED.through`,
    [through],
  );
  return { through };
}

/** Writes, queries and imports per day since `since`. */
export async function countByDay(
  c: QueryClient,
  scope: ActivityScope,
  since: string,
): Promise<DailyActivity> {
  const days: DailyActivity = { writes: {}, queries: {}, imports: {} };
  for (const t of await countActivity(c, scope, { since })) {
    days[t.log][t.day] = (days[t.log][t.day] ?? 0) + t.n;
  }
  return days;
}

/** Each log's total from `since` until `until`, and its top `limit` rows. */
export async function summarizeActivity(
  c: QueryClient,
  scope: ActivityScope,
  period: { since: string; until: string },
  limit: number,
): Promise<ActivitySummary> {
  const tallies = await countActivity(c, scope, period);
  const of = (log: Log) => tallies.filter((t) => t.log === log);
  const total = (log: Log) => of(log).reduce((sum, t) => sum + t.n, 0);

  const actors = [...new Set(tallies.flatMap((t) => (t.actor ? [t.actor] : [])))];
  const { rows } = await c.query<{ id: string; username: string }>(
    "SELECT id, COALESCE(github_login, email, id) AS username FROM users WHERE id = ANY($1::text[])",
    [actors],
  );
  const usernames = new Map(rows.map((r) => [r.id, r.username]));
  const people = (log: Log): TopActor[] =>
    ranked(
      merged(of(log), (t) => [t.actor, t.via]).flatMap((t) => {
        const username = t.actor ? usernames.get(t.actor) : undefined;
        // A hook token or an anonymous reader has no person to list.
        if (!t.actor || !username) return [];
        return [{ userId: t.actor, username, via: t.via, count: t.n, lastAt: t.lastAt }];
      }),
      limit,
    );

  return {
    writes: total("writes"),
    queries: total("queries"),
    imports: total("imports"),
    topContributors: people("writes"),
    topQueryers: people("queries"),
    topIntegrations: ranked(
      merged(of("imports"), (t) => [t.via]).map((t) => {
        const integration = t.via ?? "";
        return {
          integration,
          name: findIntegration(integration)?.name ?? integration,
          count: t.n,
          lastAt: t.lastAt,
        };
      }),
      limit,
    ),
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

/** `tallies` summed by `key`: counts added, the latest time kept. */
function merged(tallies: Tally[], key: (t: Tally) => unknown[]): Tally[] {
  const byKey = new Map<string, Tally>();
  for (const t of tallies) {
    const k = JSON.stringify(key(t));
    const seen = byKey.get(k);
    if (!seen) byKey.set(k, { ...t });
    else {
      seen.n += t.n;
      if (t.lastAt > seen.lastAt) seen.lastAt = t.lastAt;
    }
  }
  return [...byKey.values()];
}

function ranked<T extends { count: number; lastAt: string }>(rows: T[], limit: number): T[] {
  return rows.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}
