// Turning a Doco into a Slack public-channel mirror, and keeping its channel
// list and members current: record the mirror, discover the team's public
// channels (never Slack Connect ones), join the ones the bot isn't in, and load
// member names. The live copy itself is slack-mirror.server.ts.
import { withClient } from "@doco/db";
import { upsertMember } from "./slack-mirror.server";

/** How far back the history backfill reaches. */
export const MIRROR_HISTORY_YEARS = 6;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly error: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Slack ${method} failed: ${error}`);
  }
}

type Json = Record<string, unknown>;

/** One Slack Web API call (form-encoded POST). Throws `SlackApiError`, with
 *  Slack's Retry-After on a rate limit. */
export async function callSlack<T extends Json>(
  token: string,
  method: string,
  params: Record<string, string | number | boolean> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString(),
  });
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    throw new SlackApiError(
      method,
      "ratelimited",
      Number.isFinite(seconds) ? seconds * 1000 : null,
    );
  }
  const body = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) {
    throw new SlackApiError(method, body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

/** Is this Slack user an admin or owner of their workspace? Only they may
 *  authorize copying the workspace's channels out of Slack. */
export async function isSlackWorkspaceAdmin(
  token: string,
  chatUserId: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const { user } = await callSlack<{ user?: Json }>(
    token,
    "users.info",
    { user: chatUserId },
    fetchImpl,
  );
  return user?.is_admin === true || user?.is_owner === true || user?.is_primary_owner === true;
}

/** Record that `docoId` mirrors Slack team `teamId`, authorized by
 *  `consentedBy`. The Doco must be private (the schema enforces it) and the
 *  team can feed only one mirror. */
export async function enableSlackMirror(args: {
  docoId: string;
  teamId: string;
  consentedBy: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<void> {
  const { team } = await callSlack<{ team?: Json }>(args.token, "team.info", {}, args.fetchImpl);
  const domain = typeof team?.domain === "string" ? team.domain : "";
  const now = args.now ?? new Date();
  const historySince = new Date(now);
  historySince.setUTCFullYear(historySince.getUTCFullYear() - MIRROR_HISTORY_YEARS);
  await withClient(async (c) => {
    const existing = await c.query<{ handle: string; doco_id: string }>(
      `SELECT d.handle, m.doco_id
         FROM group_chat_mirrors m
         JOIN group_chat_installations i ON i.id = m.installation_id
         JOIN docos d ON d.id = m.doco_id
        WHERE i.provider = 'slack' AND i.workspace_id = $1`,
      [args.teamId],
    );
    const other = existing.rows.find((row) => row.doco_id !== args.docoId);
    if (other) throw new Error(`This Slack workspace is already mirrored into ${other.handle}.`);
    await c.query(
      `INSERT INTO group_chat_mirrors
         (doco_id, installation_id, team_domain, history_since, consented_by, consented_at)
       SELECT $1, i.id, $3, $4, $5, $6
         FROM group_chat_installations i
        WHERE i.provider = 'slack' AND i.workspace_id = $2
       ON CONFLICT (doco_id) DO UPDATE SET
         team_domain = EXCLUDED.team_domain,
         consented_by = EXCLUDED.consented_by,
         consented_at = EXCLUDED.consented_at`,
      [args.docoId, args.teamId, domain, historySince, args.consentedBy, now],
    );
  });
}

/**
 * Bring the mirror's channel list in line with the team's public channels:
 * track new ones, refresh names, drop ones that were deleted, made private, or
 * shared with another organization (their copied messages go with them), and
 * join every tracked channel the bot isn't in yet — until `deadline`. Excluded
 * channels are left alone. Archived channels keep their copy (archiving isn't
 * deleting) but can't be joined, so one never joined before archiving has no
 * history to copy.
 */
export async function syncSlackMirrorChannels(args: {
  docoId: string;
  token: string;
  fetchImpl?: typeof fetch;
  deadline?: number;
}): Promise<{ joined: number; pending: number }> {
  const publicChannels: Json[] = [];
  let cursor = "";
  do {
    const page = await callSlack<{ channels?: Json[]; response_metadata?: Json }>(
      args.token,
      "conversations.list",
      {
        types: "public_channel",
        exclude_archived: false,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      },
      args.fetchImpl,
    );
    publicChannels.push(...(page.channels ?? []));
    cursor = String(page.response_metadata?.next_cursor ?? "");
  } while (cursor);

  const ownChannels = publicChannels.filter(
    (ch) => ch.is_ext_shared !== true && ch.is_pending_ext_shared !== true,
  );
  await withClient(async (c) => {
    await c.query(
      "DELETE FROM group_chat_channels WHERE doco_id = $1 AND NOT (channel_id = ANY($2::text[]))",
      [args.docoId, ownChannels.map((ch) => String(ch.id))],
    );
    for (const ch of ownChannels) {
      await c.query(
        `INSERT INTO group_chat_channels
           (doco_id, channel_id, name, topic, purpose, archived, joined_at)
         VALUES ($1, $2, $3, $4, $5, $7, CASE WHEN $6 THEN now() END)
         ON CONFLICT (doco_id, channel_id) DO UPDATE SET
           name = EXCLUDED.name,
           topic = EXCLUDED.topic,
           purpose = EXCLUDED.purpose,
           archived = EXCLUDED.archived,
           joined_at = COALESCE(group_chat_channels.joined_at, EXCLUDED.joined_at)`,
        [
          args.docoId,
          String(ch.id),
          String(ch.name ?? ""),
          String((ch.topic as Json | undefined)?.value ?? ""),
          String((ch.purpose as Json | undefined)?.value ?? ""),
          ch.is_member === true,
          ch.is_archived === true,
        ],
      );
    }
  });

  const toJoin = await withClient(async (c) =>
    (
      await c.query<{ channel_id: string }>(
        `SELECT channel_id FROM group_chat_channels
          WHERE doco_id = $1 AND joined_at IS NULL AND NOT excluded AND NOT archived
          ORDER BY channel_id`,
        [args.docoId],
      )
    ).rows.map((row) => row.channel_id),
  );
  // Joins stop at the deadline or when Slack rate-limits them; the rest are
  // joined by the next sync.
  let joined = 0;
  for (const channelId of toJoin) {
    if (args.deadline !== undefined && Date.now() > args.deadline) break;
    try {
      await callSlack(args.token, "conversations.join", { channel: channelId }, args.fetchImpl);
    } catch (error) {
      if (error instanceof SlackApiError && error.error === "ratelimited") break;
      throw error;
    }
    await withClient((c) =>
      c.query(
        "UPDATE group_chat_channels SET joined_at = now() WHERE doco_id = $1 AND channel_id = $2",
        [args.docoId, channelId],
      ),
    );
    joined++;
  }
  return { joined, pending: toJoin.length - joined };
}

/** Load every member of the team, so the mirror can show names. */
export async function syncSlackMirrorMembers(args: {
  docoId: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  let cursor = "";
  do {
    const page = await callSlack<{ members?: Json[]; response_metadata?: Json }>(
      args.token,
      "users.list",
      { limit: 200, ...(cursor ? { cursor } : {}) },
      args.fetchImpl,
    );
    for (const member of page.members ?? []) await upsertMember(args.docoId, member);
    cursor = String(page.response_metadata?.next_cursor ?? "");
  } while (cursor);
}

export type TurnOnSlackMirrorResult =
  | { ok: true; handle: string }
  | { ok: false; reason: "doco_not_found" }
  | { ok: false; reason: "not_slack_admin"; handle: string };

/**
 * Finish turning the mirror on, after the Slack OAuth round-trip the consent
 * form started: the Doco must still live in the Slack team's bound workspace,
 * and the Slack user who approved must be a Slack admin or owner — the one
 * who can authorize copying the workspace's channels out of Slack.
 */
export async function turnOnSlackMirror(args: {
  docoId: string;
  docoWorkspaceId: string;
  installerId: string;
  teamId: string;
  authedChatUserId: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<TurnOnSlackMirrorResult> {
  const doco = await withClient(
    async (c) =>
      (
        await c.query<{ handle: string }>(
          "SELECT handle FROM docos WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
          [args.docoId, args.docoWorkspaceId],
        )
      ).rows[0],
  );
  if (!doco) return { ok: false, reason: "doco_not_found" };
  if (
    !args.authedChatUserId ||
    !(await isSlackWorkspaceAdmin(args.token, args.authedChatUserId, args.fetchImpl))
  ) {
    return { ok: false, reason: "not_slack_admin", handle: doco.handle };
  }
  await enableSlackMirror({
    docoId: args.docoId,
    teamId: args.teamId,
    consentedBy: args.installerId,
    token: args.token,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  return { ok: true, handle: doco.handle };
}

/** First sync after turning the mirror on: channels (joining as many as the
 *  budget allows) and members. Later syncs pick up anything left. */
export async function startSlackMirror(args: {
  docoId: string;
  token: string;
  budgetMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (args.budgetMs ?? 240_000);
  await syncSlackMirrorChannels({ docoId: args.docoId, token: args.token, deadline });
  await syncSlackMirrorMembers({ docoId: args.docoId, token: args.token });
}

export interface SlackMirrorChannelStatus {
  channelId: string;
  name: string;
  excluded: boolean;
  joined: boolean;
  archived: boolean;
  messages: number;
  /** How far back the history backfill has copied (ISO), null before it starts. */
  historyBackTo: string | null;
  historyDone: boolean;
}

export interface SlackMirrorStatus {
  teamName: string;
  teamDomain: string;
  consentedAt: string;
  historySince: string;
  messageCount: number;
  /** Threads whose earlier replies the backfill still has to fetch. */
  threadsPending: number;
  channels: SlackMirrorChannelStatus[];
}

export async function loadSlackMirrorStatus(docoId: string): Promise<SlackMirrorStatus | null> {
  return withClient(async (c) => {
    const mirror = (
      await c.query<{
        workspace_name: string;
        team_domain: string;
        consented_at: Date;
        history_since: Date;
      }>(
        `SELECT i.workspace_name, m.team_domain, m.consented_at, m.history_since
           FROM group_chat_mirrors m
           JOIN group_chat_installations i ON i.id = m.installation_id
          WHERE m.doco_id = $1`,
        [docoId],
      )
    ).rows[0];
    if (!mirror) return null;
    const channels = (
      await c.query<{
        channel_id: string;
        name: string;
        excluded: boolean;
        joined: boolean;
        archived: boolean;
        messages: number;
        history_oldest_ts: string | null;
        history_done: boolean;
      }>(
        `SELECT ch.channel_id, ch.name, ch.excluded, ch.joined_at IS NOT NULL AS joined, ch.archived,
                ch.history_oldest_ts, ch.history_done_at IS NOT NULL AS history_done,
                (SELECT count(*)::int FROM group_chat_messages m
                  WHERE m.doco_id = ch.doco_id AND m.channel_id = ch.channel_id) AS messages
           FROM group_chat_channels ch
          WHERE ch.doco_id = $1
          ORDER BY ch.name, ch.channel_id`,
        [docoId],
      )
    ).rows.map((row) => ({
      channelId: row.channel_id,
      name: row.name,
      excluded: row.excluded,
      joined: row.joined,
      archived: row.archived,
      messages: Number(row.messages),
      historyBackTo: row.history_oldest_ts
        ? new Date(Number(row.history_oldest_ts) * 1000).toISOString()
        : null,
      historyDone: row.history_done,
    }));
    const threadsPending = Number(
      (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM group_chat_messages
            WHERE doco_id = $1 AND reply_count > 0 AND replies_synced_at IS NULL`,
          [docoId],
        )
      ).rows[0]?.n ?? 0,
    );
    return {
      teamName: mirror.workspace_name,
      teamDomain: mirror.team_domain,
      consentedAt: new Date(mirror.consented_at).toISOString(),
      historySince: new Date(mirror.history_since).toISOString(),
      messageCount: channels.reduce((sum, ch) => sum + ch.messages, 0),
      threadsPending,
      channels,
    };
  });
}

/** Exclude a channel (deleting everything copied from it) or re-include it
 *  (the next channel sync joins it; history backfill then copies it). */
export async function setSlackMirrorChannelExcluded(args: {
  docoId: string;
  channelId: string;
  excluded: boolean;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE group_chat_channels
          SET excluded = $3, history_cursor = NULL, history_done_at = NULL
        WHERE doco_id = $1 AND channel_id = $2`,
      [args.docoId, args.channelId, args.excluded],
    );
    if (args.excluded) {
      await c.query("DELETE FROM group_chat_messages WHERE doco_id = $1 AND channel_id = $2", [
        args.docoId,
        args.channelId,
      ]);
    }
  });
}

/** Stop mirroring: deletes the mirror and, by cascade, the whole copy. */
export async function stopSlackMirror(docoId: string): Promise<void> {
  await withClient((c) => c.query("DELETE FROM group_chat_mirrors WHERE doco_id = $1", [docoId]));
}
