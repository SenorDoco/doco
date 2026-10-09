// Silence alerts: an integration Doco that stopped receiving data, or an agent
// that stopped reading and writing in a workspace, for longer than its own
// history makes expected. An hourly cron (api.alerts.silence-check) opens and
// closes them and emails each new one once; the Workspaces page, each
// workspace's page and the Docos they concern show the open ones.
//
// An integration Doco's data is what it copies from its source; an agent's is
// every read (the query log) and write (changesets) its person made through a
// connection they haven't revoked, named as `agentName` names it.
//
// What counts as unexpected is learned from each source's own rhythm: the
// silence so far is compared with the same hours of each of the past four
// weeks. It alerts once it has lasted a day, and every one of those four weeks
// brought something in the same hours, five or more on average (by chance,
// none at all would then happen less than 1% of the time). Nights, weekends
// and sources that are quiet anyway never alert, a busy source that stops
// does, and nothing alerts before a source has four weeks of history. An alert
// closes itself, row deleted, when data or calls resume, and a new silence
// later is a new alert with its own email.

import { generateUlid } from "@doco/shared";
import { agentName } from "./authoring-provenance";
import { emailHtml } from "./email-html";
import { type Email, type EmailResult, emailConfigured, sendEmail } from "./email.server";
import { type SourceIntegration, sourceIntegrationFor } from "./integrations-catalog";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** Weeks of history a silence is compared with. */
export const WEEKS = 4;
/** No silence alerts before it has lasted this long. */
export const MIN_QUIET_HOURS = 24;
/** The fewest arrivals the same hours must have brought on average. */
export const MIN_USUAL = 5;

/** Something that has gone quiet unexpectedly, as the check finds it. */
interface Silence {
  workspaceId: string;
  /** An integration Doco, or an agent: a person and the agent they work
   *  through, as `agentName` names it. */
  docoId: string | null;
  userId: string | null;
  agent: string | null;
  /** The Docos it concerns: the integration Doco, or the ones the agent used. */
  docoIds: string[];
  quietSince: string;
  usual: number;
}

/**
 * The subjects among `arrivals` (rows of `key text[]`, `at timestamptz`,
 * `n int`) that have gone quiet unexpectedly at `now`, with the last arrival
 * and what the same hours of the past weeks brought on average. Week k's
 * window is the silence shifted back k weeks: from the last arrival to now.
 * `now` is $1 in `arrivals`; `params` follow from $2.
 */
async function quietKeys(
  c: QueryClient,
  arrivals: string,
  now: Date,
  ...params: unknown[]
): Promise<{ key: string[]; quietSince: string; usual: number }[]> {
  const rows = (
    await c.query<{ key: string[]; last_at: Date | string; usual: number }>(
      `WITH arrivals AS (${arrivals}),
            spans AS (
              SELECT key, min(at) AS first_at, max(at) AS last_at FROM arrivals GROUP BY key),
            weeks AS (
              SELECT s.key, k.k,
                     coalesce(sum(a.n) FILTER (
                       WHERE a.at >= s.last_at - k.k * interval '1 week'
                         AND a.at < $1::timestamptz - k.k * interval '1 week'), 0) AS n
                FROM spans s
                CROSS JOIN generate_series(1, ${WEEKS}) AS k(k)
                JOIN arrivals a ON a.key = s.key AND a.at >= s.last_at - interval '${WEEKS} weeks'
               WHERE s.last_at <= $1::timestamptz - interval '${MIN_QUIET_HOURS} hours'
                 AND s.first_at <= $1::timestamptz - interval '${WEEKS} weeks'
               GROUP BY s.key, k.k)
       SELECT w.key, s.last_at, avg(w.n)::float8 AS usual
         FROM weeks w JOIN spans s USING (key)
        GROUP BY w.key, s.last_at
       HAVING min(w.n) > 0 AND avg(w.n) >= ${MIN_USUAL}`,
      [now.toISOString(), ...params],
    )
  ).rows;
  return rows.map((r) => ({
    key: r.key,
    quietSince: new Date(r.last_at).toISOString(),
    usual: Math.round(Number(r.usual)),
  }));
}

/** Docos still connected to the source they fill from: a Slack or Notion
 *  mirror, or GitHub repositories or an organization's installation. */
const CONNECTED_DOCOS_SQL = `
  SELECT d.id FROM docos d
   WHERE d.deleted_at IS NULL
     AND (EXISTS (SELECT 1 FROM group_chat_mirrors m WHERE m.doco_id = d.id)
       OR EXISTS (SELECT 1 FROM notion_mirrors n WHERE n.doco_id = d.id)
       OR (CASE jsonb_typeof(d.data->'github_integration'->'connections')
             WHEN 'array' THEN jsonb_array_length(d.data->'github_integration'->'connections')
             ELSE 0 END)
        + (CASE jsonb_typeof(d.data->'github_integration'->'installations')
             WHEN 'array' THEN jsonb_array_length(d.data->'github_integration'->'installations')
             ELSE 0 END) > 0)`;

async function quietIntegrations(c: QueryClient, now: Date): Promise<Silence[]> {
  const quiet = await quietKeys(
    c,
    `SELECT ARRAY[r.doco_id] AS key, r.at, 1 AS n
       FROM imported_items r
      WHERE r.at IS NOT NULL AND r.doco_id IN (${CONNECTED_DOCOS_SQL})`,
    now,
  );
  if (quiet.length === 0) return [];
  const workspaces = new Map(
    (
      await c.query<{ id: string; workspace_id: string }>(
        "SELECT id, workspace_id FROM docos WHERE id = ANY($1::text[])",
        [quiet.map((q) => q.key[0])],
      )
    ).rows.map((r) => [r.id, r.workspace_id]),
  );
  return quiet.flatMap(({ key: [docoId], quietSince, usual }) => {
    const workspaceId = docoId ? workspaces.get(docoId) : undefined;
    if (!docoId || !workspaceId) return [];
    return [
      { workspaceId, docoId, userId: null, agent: null, docoIds: [docoId], quietSince, usual },
    ];
  });
}

/** Every read (the query log) and write (changesets) a person made in a
 *  workspace, with the request context that names the agent behind it. A
 *  search across a whole workspace names no Doco. */
const PEOPLE_LOG_SQL = `
  SELECT q.workspace_id, q.doco_id, q.actor, q.source, q.metadata, q.at
    FROM query_events q WHERE q.actor IS NOT NULL
  UNION ALL
  SELECT d.workspace_id, cs.doco_id, cs.actor, cs.source, cs.metadata, cs.recorded_at
    FROM changesets cs JOIN docos d ON d.id = cs.doco_id WHERE cs.actor IS NOT NULL`;

/** The agents people have connected and not revoked, as [person, name] JSON:
 *  named the way `agentName` names the reads and writes made through them.
 *  Revoking one is how its person says it was retired on purpose. */
async function connectedAgents(c: QueryClient, now: Date): Promise<Set<string>> {
  const rows = (
    await c.query<{ user_id: string; token_name: string | null; client_name: string | null }>(
      `SELECT rt.user_id, rt.token_name, oc.client_name
         FROM oauth_refresh_tokens rt JOIN oauth_clients oc ON oc.client_id = rt.client_id
        WHERE NOT rt.revoked AND rt.expires_at > $1`,
      [now.toISOString()],
    )
  ).rows;
  return new Set(
    rows.map((r) =>
      JSON.stringify([
        r.user_id,
        agentName("api", { auth: "oauth", token_name: r.token_name, client_name: r.client_name }),
      ]),
    ),
  );
}

async function quietAgents(c: QueryClient, now: Date): Promise<Silence[]> {
  const connected = await connectedAgents(c, now);
  const names = new Set([...connected].map((k) => (JSON.parse(k) as string[])[1]));
  // The request contexts that name a connected agent, matched in SQL.
  const contexts = (
    await c.query<{ source: string; metadata: Record<string, unknown> | null }>(
      `SELECT DISTINCT source, metadata FROM (${PEOPLE_LOG_SQL}) e`,
    )
  ).rows.flatMap(({ source, metadata }) => {
    const agent = agentName(source, metadata);
    return agent && names.has(agent) ? [{ source, metadata, agent }] : [];
  });
  if (contexts.length === 0) return [];
  // $2 in both queries below.
  const agentLog = `
    SELECT e.workspace_id, e.actor, x.agent, e.doco_id, e.at
      FROM (${PEOPLE_LOG_SQL}) e
      JOIN jsonb_to_recordset($2::jsonb) AS x(source text, metadata jsonb, agent text)
        ON x.source = e.source AND x.metadata IS NOT DISTINCT FROM e.metadata`;
  const quiet = (
    await quietKeys(
      c,
      `SELECT ARRAY[workspace_id, actor, agent] AS key, at, 1 AS n FROM (${agentLog}) l`,
      now,
      JSON.stringify(contexts),
    )
  ).filter(({ key: [, userId, agent] }) => connected.has(JSON.stringify([userId, agent])));
  if (quiet.length === 0) return [];
  // The Docos each used in its last four weeks, while its person still
  // belongs to the workspace or one of its Docos.
  const used = new Map(
    (
      await c.query<{ key: string[]; doco_ids: string[] }>(
        `SELECT k.key, array_remove(array_agg(DISTINCT l.doco_id ORDER BY l.doco_id), NULL) AS doco_ids
           FROM jsonb_to_recordset($1::jsonb) AS k(key text[], since timestamptz)
           JOIN (${agentLog}) l
             ON ARRAY[l.workspace_id, l.actor, l.agent] = k.key
            AND l.at >= k.since - interval '${WEEKS} weeks'
          WHERE EXISTS (SELECT 1 FROM workspace_users wu
                         WHERE wu.workspace_id = k.key[1] AND wu.user_id = k.key[2])
             OR EXISTS (SELECT 1 FROM doco_users du JOIN docos d ON d.id = du.doco_id
                         WHERE d.workspace_id = k.key[1] AND du.user_id = k.key[2])
          GROUP BY k.key`,
        [
          JSON.stringify(quiet.map((q) => ({ key: q.key, since: q.quietSince }))),
          JSON.stringify(contexts),
        ],
      )
    ).rows.map((r) => [JSON.stringify(r.key), r.doco_ids]),
  );
  return quiet.flatMap(({ key, quietSince, usual }) => {
    const [workspaceId, userId, agent] = key;
    const docoIds = used.get(JSON.stringify(key));
    if (!workspaceId || !userId || !agent || !docoIds) return [];
    return [{ workspaceId, docoId: null, userId, agent, docoIds, quietSince, usual }];
  });
}

const subjectOf = (s: {
  workspaceId: string;
  docoId: string | null;
  userId: string | null;
  agent: string | null;
}) => JSON.stringify(s.docoId ? [s.docoId] : [s.workspaceId, s.userId, s.agent]);

/**
 * Bring the open alerts in line with what is quiet now: open an alert for each
 * new silence, refresh the ones still quiet, and delete the rest (data or
 * calls resumed, the source was disconnected, the agent's connection revoked).
 */
export async function checkSilences(
  c: QueryClient,
  now: Date = new Date(),
): Promise<{ opened: number; closed: number; open: number }> {
  const quiet = [...(await quietIntegrations(c, now)), ...(await quietAgents(c, now))];
  const open = (
    await c.query<{
      id: string;
      workspace_id: string;
      doco_id: string | null;
      user_id: string | null;
      agent: string | null;
    }>("SELECT id, workspace_id, doco_id, user_id, agent FROM silence_alerts")
  ).rows;
  const openBySubject = new Map(
    open.map((a) => [
      subjectOf({
        workspaceId: a.workspace_id,
        docoId: a.doco_id,
        userId: a.user_id,
        agent: a.agent,
      }),
      a.id,
    ]),
  );
  let opened = 0;
  const kept = new Set<string>();
  for (const s of quiet) {
    const id = openBySubject.get(subjectOf(s));
    if (id) {
      kept.add(id);
      await c.query(
        "UPDATE silence_alerts SET doco_ids = $2, quiet_since = $3, usual = $4 WHERE id = $1",
        [id, s.docoIds, s.quietSince, s.usual],
      );
      continue;
    }
    opened++;
    await c.query(
      `INSERT INTO silence_alerts
         (id, workspace_id, doco_id, user_id, agent, doco_ids, quiet_since, usual, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        `alert_${generateUlid()}`,
        s.workspaceId,
        s.docoId,
        s.userId,
        s.agent,
        s.docoIds,
        s.quietSince,
        s.usual,
        now.toISOString(),
      ],
    );
  }
  const closed = open.filter((a) => !kept.has(a.id)).map((a) => a.id);
  if (closed.length > 0) {
    await c.query("DELETE FROM silence_alerts WHERE id = ANY($1::text[])", [closed]);
  }
  return { opened, closed: closed.length, open: quiet.length };
}

/** An open alert as people read it. */
export type SilenceAlert =
  | {
      id: string;
      kind: "integration";
      workspaceHandle: string;
      quietSince: string;
      usual: number;
      docoHandle: string;
      source: SourceIntegration;
    }
  | {
      id: string;
      kind: "agent";
      workspaceHandle: string;
      quietSince: string;
      usual: number;
      /** As `agentName` names it: the connection's name, or "MCP", "Slack"… */
      agentName: string;
      /** The GitHub login of the person it acts for. */
      agentUser: string | null;
      /** The Docos it used. */
      docoHandles: string[];
    };

type AlertRow = {
  id: string;
  workspace_handle: string;
  quiet_since: Date | string;
  usual: number;
  doco_handle: string | null;
  template: string | null;
  agent_name: string | null;
  agent_user: string | null;
  doco_handles: string[];
};

const ALERTS_SQL = `
  SELECT a.id, w.handle AS workspace_handle, a.quiet_since, a.usual,
         d.handle AS doco_handle, d.data->>'template_handle' AS template,
         a.agent AS agent_name,
         u.github_login AS agent_user,
         ARRAY(SELECT ud.handle FROM docos ud
                WHERE ud.id = ANY(a.doco_ids) AND ud.deleted_at IS NULL
                ORDER BY ud.handle) AS doco_handles
    FROM silence_alerts a
    JOIN workspaces w ON w.id = a.workspace_id
    LEFT JOIN docos d ON d.id = a.doco_id
    LEFT JOIN users u ON u.id = a.user_id
   WHERE (a.doco_id IS NULL OR d.deleted_at IS NULL)`;

function toAlert(r: AlertRow): SilenceAlert {
  const common = {
    id: r.id,
    workspaceHandle: r.workspace_handle,
    quietSince: new Date(r.quiet_since).toISOString(),
    usual: Number(r.usual),
  };
  if (r.doco_handle) {
    return {
      ...common,
      kind: "integration",
      docoHandle: r.doco_handle,
      // A Doco connected to GitHub from a template that doesn't fill from it
      // predates the dedicated GitHub templates.
      source: sourceIntegrationFor(r.template) ?? "github",
    };
  }
  return {
    ...common,
    kind: "agent",
    agentName: r.agent_name ?? "An agent",
    agentUser: r.agent_user,
    docoHandles: r.doco_handles ?? [],
  };
}

/** The open alerts that concern any of these Docos, oldest silence first. */
export async function loadSilenceAlerts(
  c: QueryClient,
  docoIds: readonly string[],
): Promise<SilenceAlert[]> {
  if (docoIds.length === 0) return [];
  const rows = (
    await c.query<AlertRow>(
      `${ALERTS_SQL} AND a.doco_ids && $1::text[] ORDER BY a.quiet_since, a.id`,
      [[...docoIds]],
    )
  ).rows;
  return rows.map(toAlert);
}

const SOURCE_NAMES: Record<SourceIntegration, string> = {
  github: "GitHub",
  slack: "Slack",
  notion: "Notion",
};

const UTC_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** "Sep 28, 14:05 UTC" */
function utc(iso: string): string {
  return `${UTC_TIME.format(new Date(iso))} UTC`;
}

/** One alert, said as email lines with their links. */
function alertLines(alert: SilenceAlert, base: string): string[] {
  if (alert.kind === "integration") {
    return [
      `${alert.docoHandle} has received nothing from ${SOURCE_NAMES[alert.source]} since ${utc(alert.quietSince)}. The same hours of each of the past four weeks brought about ${alert.usual} updates, so this silence is unusual.`,
      `Check its connection: ${base}/${alert.docoHandle}/integrations/${alert.source}`,
    ];
  }
  const who = alert.agentUser ? `@${alert.agentUser}` : "its person";
  return [
    `${alert.agentName}, the agent ${who} connected, hasn't read or written in the ${alert.workspaceHandle} workspace since ${utc(alert.quietSince)}. The same hours of each of the past four weeks saw about ${alert.usual} reads and writes, so this silence is unusual.`,
    alert.docoHandles.length > 0
      ? `Docos it used: ${alert.docoHandles.map((h) => `${base}/${h}`).join(", ")}`
      : null,
    `If it was retired on purpose, ${who} can revoke its connection at ${base}/tokens and the alert goes away.`,
  ].filter((line): line is string => line !== null);
}

function alertSubject(alert: SilenceAlert): string {
  return alert.kind === "integration"
    ? `${alert.docoHandle} stopped receiving data from ${SOURCE_NAMES[alert.source]}`
    : `${alert.agentName} stopped using the ${alert.workspaceHandle} workspace`;
}

/** The email one person gets for the new alerts that concern them. */
export function alertEmail(to: string, alerts: SilenceAlert[], base: string): Email {
  const first = alerts[0];
  const subject =
    alerts.length === 1 && first ? alertSubject(first) : `${alerts.length} Doco alerts`;
  const lines = alerts.map((a) => alertLines(a, base));
  const closing = [
    "Each alert clears by itself as soon as data or calls resume.",
    `Doco · ${base}`,
  ];
  return {
    to,
    subject: `Doco alert: ${subject}`,
    text: [...lines.map((l) => l.join("\n")), ...closing].join("\n\n"),
    html: emailHtml([...lines.flat(), ...closing]),
  };
}

/**
 * Email each alert not emailed yet, once: to the owners of the Docos it
 * concerns and, for an agent, to the person it acts for. Each person gets one
 * email for all of theirs. Nothing is marked emailed while email isn't
 * configured, so the open alerts go out once it is.
 */
export async function emailNewAlerts(
  c: QueryClient,
  base: string,
  send: (email: Email) => Promise<EmailResult> = sendEmail,
): Promise<{ emailed: number; emails: number }> {
  if (!emailConfigured()) return { emailed: 0, emails: 0 };
  const rows = (
    await c.query<AlertRow>(
      `${ALERTS_SQL} AND a.emailed_at IS NULL
       ORDER BY a.quiet_since, a.id`,
    )
  ).rows;
  if (rows.length === 0) return { emailed: 0, emails: 0 };
  const recipients = (
    await c.query<{ id: string; email: string }>(
      `SELECT DISTINCT a.id, u.email
         FROM silence_alerts a
         JOIN users u
           ON u.id = a.user_id
           OR u.id IN (SELECT wu.user_id FROM workspace_users wu
                         JOIN docos d ON d.workspace_id = wu.workspace_id
                        WHERE d.id = ANY(a.doco_ids) AND wu.role = 'owner')
           OR u.id IN (SELECT du.user_id FROM doco_users du
                        WHERE du.doco_id = ANY(a.doco_ids) AND du.role = 'owner')
        WHERE a.id = ANY($1::text[])
          AND u.deactivated_at IS NULL AND coalesce(trim(u.email), '') <> ''`,
      [rows.map((r) => r.id)],
    )
  ).rows;
  const alerts = new Map(rows.map((r) => [r.id, toAlert(r)]));
  const byEmail = new Map<string, SilenceAlert[]>();
  for (const { id, email } of recipients) {
    const alert = alerts.get(id);
    if (alert) byEmail.set(email, [...(byEmail.get(email) ?? []), alert]);
  }
  for (const [to, theirs] of byEmail) {
    await send(alertEmail(to, theirs, base));
  }
  await c.query("UPDATE silence_alerts SET emailed_at = now() WHERE id = ANY($1::text[])", [
    rows.map((r) => r.id),
  ]);
  return { emailed: rows.length, emails: byEmail.size };
}
