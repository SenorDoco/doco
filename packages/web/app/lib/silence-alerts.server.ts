// Silence alerts: an integration Doco that stopped receiving data, or an agent
// that stopped reading and writing in a workspace, for longer than its own
// history makes expected. An hourly cron (api.alerts.silence-check) opens and
// closes them and emails each new one once; the Workspaces page, each
// workspace's page and the Docos they concern show the open ones.
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
import { COPIED_ITEMS_SQL } from "./doco-stats.server";
import { type Email, type EmailResult, emailConfigured, sendEmail } from "./email.server";
import { GITHUB_ITEMS_SQL } from "./integration-status.server";
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
  /** An integration Doco, or an agent: a connection and the person it acts for. */
  docoId: string | null;
  clientId: string | null;
  userId: string | null;
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
 */
async function quietKeys(
  c: QueryClient,
  arrivals: string,
  now: Date,
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
      [now.toISOString()],
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
       FROM (${COPIED_ITEMS_SQL} UNION ALL ${GITHUB_ITEMS_SQL}) r
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
      { workspaceId, docoId, clientId: null, userId: null, docoIds: [docoId], quietSince, usual },
    ];
  });
}

const subjectOf = (s: {
  workspaceId: string;
  docoId: string | null;
  clientId: string | null;
  userId: string | null;
}) => (s.docoId ? `doco ${s.docoId}` : `agent ${s.workspaceId} ${s.clientId} ${s.userId}`);

/**
 * Bring the open alerts in line with what is quiet now: open an alert for each
 * new silence, refresh the ones still quiet, and delete the rest (data or
 * calls resumed, the source was disconnected, the connection revoked).
 */
export async function checkSilences(
  c: QueryClient,
  now: Date = new Date(),
): Promise<{ opened: number; closed: number; open: number }> {
  // Agents join once Doco logs each agent's reads (the Activity charts' query
  // log); their alerts already have their place in the table and the views.
  const quiet = await quietIntegrations(c, now);
  const open = (
    await c.query<{
      id: string;
      workspace_id: string;
      doco_id: string | null;
      client_id: string | null;
      user_id: string | null;
    }>("SELECT id, workspace_id, doco_id, client_id, user_id FROM silence_alerts")
  ).rows;
  const openBySubject = new Map(
    open.map((a) => [
      subjectOf({
        workspaceId: a.workspace_id,
        docoId: a.doco_id,
        clientId: a.client_id,
        userId: a.user_id,
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
         (id, workspace_id, doco_id, client_id, user_id, doco_ids, quiet_since, usual, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        `alert_${generateUlid()}`,
        s.workspaceId,
        s.docoId,
        s.clientId,
        s.userId,
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
      /** The name its person gave the connection, else the app's own. */
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
         coalesce(nullif(trim(rt.token_name), ''), oc.client_name, a.client_id) AS agent_name,
         u.github_login AS agent_user,
         ARRAY(SELECT ud.handle FROM docos ud
                WHERE ud.id = ANY(a.doco_ids) AND ud.deleted_at IS NULL
                ORDER BY ud.handle) AS doco_handles
    FROM silence_alerts a
    JOIN workspaces w ON w.id = a.workspace_id
    LEFT JOIN docos d ON d.id = a.doco_id
    LEFT JOIN oauth_clients oc ON oc.client_id = a.client_id
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN LATERAL (
      SELECT token_name FROM oauth_refresh_tokens
       WHERE client_id = a.client_id AND user_id = a.user_id
       ORDER BY created_at DESC LIMIT 1) rt ON true
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

/** One alert, said as an email paragraph with its links. */
function alertParagraph(alert: SilenceAlert, base: string): string {
  if (alert.kind === "integration") {
    return [
      `${alert.docoHandle} has received nothing from ${SOURCE_NAMES[alert.source]} since ${utc(alert.quietSince)}. The same hours of each of the past four weeks brought about ${alert.usual} updates, so this silence is unusual.`,
      `Check its connection: ${base}/${alert.docoHandle}/integrations/${alert.source}`,
    ].join("\n");
  }
  const who = alert.agentUser ? `@${alert.agentUser}` : "its person";
  return [
    `${alert.agentName}, the agent ${who} connected, hasn't read or written in the ${alert.workspaceHandle} workspace since ${utc(alert.quietSince)}. The same hours of each of the past four weeks saw about ${alert.usual} reads and writes, so this silence is unusual.`,
    alert.docoHandles.length > 0
      ? `Docos it used: ${alert.docoHandles.map((h) => `${base}/${h}`).join(", ")}`
      : null,
    `If it was retired on purpose, ${who} can revoke its connection at ${base}/tokens and the alert goes away.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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
  const text = [
    ...alerts.map((a) => alertParagraph(a, base)),
    "Each alert clears by itself as soon as data or calls resume.",
    `Doco · ${base}`,
  ].join("\n\n");
  return { to, subject: `Doco alert: ${subject}`, text };
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
