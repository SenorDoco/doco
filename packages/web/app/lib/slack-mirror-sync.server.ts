// The Slack mirror's paced background sync, run once a minute per mirror by
// /api/slack/mirror-sync:
//
//   - hourly, the channel list and members are refreshed (new channels are
//     joined, gone ones dropped — see syncSlackMirrorChannels); while channels
//     are still waiting to be joined, every run retries them;
//   - history is backfilled one conversations.history page at a time, always
//     advancing the channel whose copy reaches least far back, so every
//     channel fills newest-first together, down to the mirror's history floor;
//   - threads found by the backfill get their earlier replies, newest thread
//     first, one conversations.replies page at a time.
//
// Slack allows apps not listed on its Marketplace one call a minute (15
// messages) per method per workspace, so each method runs at most
// `callsPerMinute` times per tick (1 unless the app's limits allow more) and
// honors Slack's Retry-After. Live messages never wait on any of this: the
// events route copies them as they happen.
import { withClient } from "@doco/db";
import {
  SlackApiError,
  callSlack,
  syncSlackMirrorChannels,
  syncSlackMirrorMembers,
} from "./slack-mirror-setup.server";
import { upsertMessage } from "./slack-mirror.server";

const MINUTE_MS = 60_000;
const CHANNEL_SYNC_INTERVAL_MS = 60 * MINUTE_MS;
const PAGE_SIZE = 200;

type Json = Record<string, unknown>;

export interface SlackMirrorTickResult {
  channelsSynced: boolean;
  historyCalls: number;
  repliesCalls: number;
  rateLimited: boolean;
}

export async function listActiveSlackMirrors(): Promise<{ docoId: string; teamId: string }[]> {
  const r = await withClient((c) =>
    c.query<{ doco_id: string; workspace_id: string }>(
      `SELECT m.doco_id, i.workspace_id
         FROM group_chat_mirrors m
         JOIN group_chat_installations i ON i.id = m.installation_id
         JOIN docos d ON d.id = m.doco_id
        WHERE i.provider = 'slack' AND d.deleted_at IS NULL
        ORDER BY m.created_at`,
    ),
  );
  return r.rows.map((row) => ({ docoId: row.doco_id, teamId: row.workspace_id }));
}

export async function runSlackMirrorTick(args: {
  docoId: string;
  token: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  callsPerMinute?: number;
}): Promise<SlackMirrorTickResult> {
  const now = args.now ?? new Date();
  const perMinute = Math.max(1, args.callsPerMinute ?? 1);
  const fetchImpl = args.fetchImpl;
  const mirror = await withClient(
    async (c) =>
      (
        await c.query<{
          history_since: Date;
          channels_synced_at: Date | null;
          history_next_at: Date | null;
          replies_next_at: Date | null;
        }>(
          `SELECT history_since, channels_synced_at, history_next_at, replies_next_at
           FROM group_chat_mirrors WHERE doco_id = $1`,
          [args.docoId],
        )
      ).rows[0],
  );
  const result: SlackMirrorTickResult = {
    channelsSynced: false,
    historyCalls: 0,
    repliesCalls: 0,
    rateLimited: false,
  };
  if (!mirror) return result;

  if (
    !mirror.channels_synced_at ||
    now.getTime() - new Date(mirror.channels_synced_at).getTime() >= CHANNEL_SYNC_INTERVAL_MS
  ) {
    const common = { docoId: args.docoId, token: args.token, ...(fetchImpl ? { fetchImpl } : {}) };
    const { pending } = await syncSlackMirrorChannels({ ...common, deadline: Date.now() + 20_000 });
    await syncSlackMirrorMembers(common);
    if (pending === 0) {
      await setMirrorTime(args.docoId, "channels_synced_at", now);
      result.channelsSynced = true;
    }
  }

  const paced = async (
    column: "history_next_at" | "replies_next_at",
    step: () => Promise<boolean>,
  ): Promise<number> => {
    const nextAt = mirror[column];
    if (nextAt && new Date(nextAt).getTime() > now.getTime()) return 0;
    let calls = 0;
    let waitMs = MINUTE_MS;
    try {
      while (calls < perMinute && (await step())) calls++;
    } catch (error) {
      if (!(error instanceof SlackApiError) || error.error !== "ratelimited") throw error;
      result.rateLimited = true;
      calls++;
      waitMs = Math.max(error.retryAfterMs ?? MINUTE_MS, MINUTE_MS);
    }
    await setMirrorTime(args.docoId, column, new Date(now.getTime() + waitMs));
    return calls;
  };

  const oldest = String(new Date(mirror.history_since).getTime() / 1000);
  result.historyCalls = await paced("history_next_at", () =>
    backfillHistoryPage(args.docoId, args.token, oldest, fetchImpl),
  );
  result.repliesCalls = await paced("replies_next_at", () =>
    backfillRepliesPage(args.docoId, args.token, fetchImpl),
  );
  return result;
}

async function setMirrorTime(
  docoId: string,
  column: "channels_synced_at" | "history_next_at" | "replies_next_at",
  value: Date,
): Promise<void> {
  await withClient((c) =>
    c.query(`UPDATE group_chat_mirrors SET ${column} = $2 WHERE doco_id = $1`, [docoId, value]),
  );
}

/** Copy the next history page of the channel whose copy reaches least far
 *  back. False when every channel's history is done. */
async function backfillHistoryPage(
  docoId: string,
  token: string,
  oldest: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const channel = await withClient(
    async (c) =>
      (
        await c.query<{ channel_id: string; history_cursor: string | null }>(
          `SELECT channel_id, history_cursor
           FROM group_chat_channels
          WHERE doco_id = $1 AND joined_at IS NOT NULL AND NOT excluded
            AND history_done_at IS NULL
          ORDER BY history_oldest_ts IS NOT NULL, history_oldest_ts::numeric DESC, channel_id
          LIMIT 1`,
          [docoId],
        )
      ).rows[0],
  );
  if (!channel) return false;
  let page: { messages?: Json[]; has_more?: boolean; response_metadata?: Json };
  try {
    page = await callSlack(
      token,
      "conversations.history",
      {
        channel: channel.channel_id,
        oldest,
        limit: PAGE_SIZE,
        ...(channel.history_cursor ? { cursor: channel.history_cursor } : {}),
      },
      fetchImpl,
    );
  } catch (error) {
    if (await settleChannelError(docoId, channel.channel_id, error)) return true;
    throw error;
  }
  const messages = page.messages ?? [];
  for (const message of messages) await upsertMessage(docoId, channel.channel_id, message);
  const nextCursor = String(page.response_metadata?.next_cursor ?? "");
  const pageOldest = messages
    .map((m) => String(m.ts ?? ""))
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))[0];
  await withClient((c) =>
    c.query(
      `UPDATE group_chat_channels
          SET history_cursor = $3,
              history_oldest_ts = CASE
                WHEN $4::text IS NULL THEN history_oldest_ts
                WHEN history_oldest_ts IS NULL OR $4::text::numeric < history_oldest_ts::numeric THEN $4::text
                ELSE history_oldest_ts END,
              history_done_at = CASE WHEN $3::text IS NULL THEN now() END
        WHERE doco_id = $1 AND channel_id = $2`,
      [
        docoId,
        channel.channel_id,
        page.has_more && nextCursor ? nextCursor : null,
        pageOldest ?? null,
      ],
    ),
  );
  return true;
}

/** Copy the next page of earlier replies of the newest thread still missing
 *  them. False when no thread is. */
async function backfillRepliesPage(
  docoId: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const root = await withClient(
    async (c) =>
      (
        await c.query<{ channel_id: string; ts: string; replies_cursor: string | null }>(
          `SELECT m.channel_id, m.ts, m.replies_cursor
           FROM group_chat_messages m
           JOIN group_chat_channels ch
             ON ch.doco_id = m.doco_id AND ch.channel_id = m.channel_id
          WHERE m.doco_id = $1 AND m.reply_count > 0 AND m.replies_synced_at IS NULL
            AND ch.joined_at IS NOT NULL AND NOT ch.excluded
          ORDER BY m.ts::numeric DESC
          LIMIT 1`,
          [docoId],
        )
      ).rows[0],
  );
  if (!root) return false;
  let page: { messages?: Json[]; has_more?: boolean; response_metadata?: Json };
  try {
    page = await callSlack(
      token,
      "conversations.replies",
      {
        channel: root.channel_id,
        ts: root.ts,
        limit: PAGE_SIZE,
        ...(root.replies_cursor ? { cursor: root.replies_cursor } : {}),
      },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof SlackApiError && error.error === "thread_not_found") {
      await markRepliesDone(docoId, root.channel_id, root.ts, null);
      return true;
    }
    if (await settleChannelError(docoId, root.channel_id, error)) return true;
    throw error;
  }
  for (const message of page.messages ?? []) await upsertMessage(docoId, root.channel_id, message);
  const nextCursor = String(page.response_metadata?.next_cursor ?? "");
  await markRepliesDone(
    docoId,
    root.channel_id,
    root.ts,
    page.has_more && nextCursor ? nextCursor : null,
  );
  return true;
}

/** Save the replies cursor, or — with none left — mark the thread done. */
async function markRepliesDone(
  docoId: string,
  channelId: string,
  ts: string,
  nextCursor: string | null,
): Promise<void> {
  await withClient((c) =>
    c.query(
      `UPDATE group_chat_messages
          SET replies_cursor = $4,
              replies_synced_at = CASE WHEN $4::text IS NULL THEN now() END
        WHERE doco_id = $1 AND channel_id = $2 AND ts = $3`,
      [docoId, channelId, ts, nextCursor],
    ),
  );
}

/** The bot was removed from the channel (the hourly channel sync rejoins it)
 *  or the channel is gone (dropped with its copy). True when handled. */
async function settleChannelError(
  docoId: string,
  channelId: string,
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof SlackApiError)) return false;
  if (error.error === "not_in_channel") {
    await withClient((c) =>
      c.query(
        "UPDATE group_chat_channels SET joined_at = NULL WHERE doco_id = $1 AND channel_id = $2",
        [docoId, channelId],
      ),
    );
    return true;
  }
  if (error.error === "channel_not_found") {
    await withClient((c) =>
      c.query("DELETE FROM group_chat_channels WHERE doco_id = $1 AND channel_id = $2", [
        docoId,
        channelId,
      ]),
    );
    return true;
  }
  return false;
}
