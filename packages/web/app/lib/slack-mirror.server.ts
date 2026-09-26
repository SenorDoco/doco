// The Slack public-channel mirror's live path: apply one Slack event to the
// mirror tables (schema.sql → "Slack public-channel mirror").
//
// Only PUBLIC channels the mirror tracks, and the owner didn't exclude, are
// copied — never DMs, private channels, or Slack Connect channels shared with
// another organization. Every write is idempotent (Slack retries deliveries)
// and edits apply only when newer (Slack doesn't guarantee order), so the
// events route can run this on every delivery, retries included.
import { withClient } from "@doco/db";

type Json = Record<string, unknown>;

export interface MirrorSlackEventInput {
  /** The Slack team id (`team_id` on the event envelope). */
  teamId: string;
  event: Json;
  /** The envelope's `is_ext_shared_channel`: a Slack Connect channel. */
  isExtSharedChannel?: boolean;
}

/** Channel notices that aren't conversation. Topic/purpose changes update the
 *  channel row instead of being stored as messages. */
const NOTICE_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_topic",
  "channel_purpose",
]);

export async function mirrorSlackEvent(input: MirrorSlackEventInput): Promise<void> {
  const docoId = await findMirrorDocoId(input.teamId);
  if (!docoId) return;
  const { event } = input;
  switch (event.type) {
    case "message":
      if (input.isExtSharedChannel) return;
      return mirrorMessageEvent(docoId, event);
    case "channel_created":
      return trackCreatedChannel(docoId, asJson(event.channel));
    case "channel_rename":
      return updateChannel(
        docoId,
        str(asJson(event.channel).id),
        "name",
        str(asJson(event.channel).name),
      );
    case "channel_archive":
    case "channel_unarchive":
      return setChannelArchived(docoId, str(event.channel), event.type === "channel_archive");
    case "channel_deleted":
    case "channel_shared":
      return dropChannel(docoId, str(event.channel));
    case "user_change":
    case "team_join":
      return upsertMember(docoId, asJson(event.user));
  }
}

async function findMirrorDocoId(teamId: string): Promise<string | null> {
  const r = await withClient((c) =>
    c.query<{ doco_id: string }>(
      `SELECT m.doco_id
         FROM group_chat_mirrors m
         JOIN group_chat_installations i ON i.id = m.installation_id
         JOIN docos d ON d.id = m.doco_id
        WHERE i.provider = 'slack' AND i.workspace_id = $1 AND d.deleted_at IS NULL`,
      [teamId],
    ),
  );
  return r.rows[0]?.doco_id ?? null;
}

async function mirrorMessageEvent(docoId: string, event: Json): Promise<void> {
  if (event.channel_type !== "channel") return;
  const channelId = str(event.channel);
  if (!channelId) return;
  const subtype = str(event.subtype);
  if (subtype === "message_deleted") {
    await withClient((c) =>
      c.query(
        "DELETE FROM group_chat_messages WHERE doco_id = $1 AND channel_id = $2 AND ts = $3",
        [docoId, channelId, str(event.deleted_ts)],
      ),
    );
    return;
  }
  if (subtype === "message_changed" || subtype === "message_replied") {
    await upsertMessage(docoId, channelId, asJson(event.message));
    return;
  }
  if (subtype === "channel_topic" || subtype === "channel_purpose") {
    const field = subtype === "channel_topic" ? "topic" : "purpose";
    await updateChannel(docoId, channelId, field, str(event[field]));
    return;
  }
  if (NOTICE_SUBTYPES.has(subtype)) return;
  await upsertMessage(docoId, channelId, event);
}

/** Upsert one Slack message into a tracked, non-excluded channel. */
export async function upsertMessage(
  docoId: string,
  channelId: string,
  message: Json,
): Promise<void> {
  const ts = str(message.ts);
  if (!ts) return;
  const replyCount = typeof message.reply_count === "number" ? message.reply_count : null;
  await withClient((c) =>
    c.query(
      `INSERT INTO group_chat_messages
         (doco_id, channel_id, ts, thread_ts, reply_count, author_id, subtype, text, files,
          edited_ts, posted_at)
       SELECT $1, $2, $3::text, $4, COALESCE($5::int, 0), $6, $7, $8, $9::jsonb, $10,
              to_timestamp($3::text::numeric)
         FROM group_chat_channels
        WHERE doco_id = $1 AND channel_id = $2 AND NOT excluded
       ON CONFLICT (doco_id, channel_id, ts) DO UPDATE SET
         thread_ts = EXCLUDED.thread_ts,
         reply_count = COALESCE($5::int, group_chat_messages.reply_count),
         author_id = EXCLUDED.author_id,
         subtype = EXCLUDED.subtype,
         text = EXCLUDED.text,
         files = EXCLUDED.files,
         edited_ts = EXCLUDED.edited_ts
       WHERE group_chat_messages.edited_ts IS NULL
          OR EXCLUDED.edited_ts::numeric >= group_chat_messages.edited_ts::numeric`,
      [
        docoId,
        channelId,
        ts,
        str(message.thread_ts) || null,
        replyCount,
        str(message.user) || str(message.bot_id) || null,
        str(message.subtype) || null,
        str(message.text),
        JSON.stringify(fileLinks(message.files)),
        str(asJson(message.edited).ts) || null,
      ],
    ),
  );
}

/** A file's identity and link only — the mirror never copies file contents. */
function fileLinks(files: unknown): Json[] {
  if (!Array.isArray(files)) return [];
  return files.map((f) => {
    const file = asJson(f);
    return Object.fromEntries(
      (["id", "name", "mimetype", "size", "permalink"] as const)
        .filter((key) => file[key] !== undefined)
        .map((key) => [key, file[key]]),
    );
  });
}

async function trackCreatedChannel(docoId: string, channel: Json): Promise<void> {
  const channelId = str(channel.id);
  if (!channelId || channel.is_shared === true || channel.is_ext_shared === true) return;
  await withClient((c) =>
    c.query(
      `INSERT INTO group_chat_channels (doco_id, channel_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (doco_id, channel_id) DO NOTHING`,
      [docoId, channelId, str(channel.name)],
    ),
  );
}

async function updateChannel(
  docoId: string,
  channelId: string,
  field: "name" | "topic" | "purpose",
  value: string,
): Promise<void> {
  await withClient((c) =>
    c.query(`UPDATE group_chat_channels SET ${field} = $3 WHERE doco_id = $1 AND channel_id = $2`, [
      docoId,
      channelId,
      value,
    ]),
  );
}

async function setChannelArchived(docoId: string, channelId: string, archived: boolean) {
  await withClient((c) =>
    c.query("UPDATE group_chat_channels SET archived = $3 WHERE doco_id = $1 AND channel_id = $2", [
      docoId,
      channelId,
      archived,
    ]),
  );
}

/** Deleted in Slack, or now shared with another organization: drop the
 *  channel and (by cascade) every message copied from it. */
async function dropChannel(docoId: string, channelId: string): Promise<void> {
  await withClient((c) =>
    c.query("DELETE FROM group_chat_channels WHERE doco_id = $1 AND channel_id = $2", [
      docoId,
      channelId,
    ]),
  );
}

export async function upsertMember(docoId: string, user: Json): Promise<void> {
  const id = str(user.id);
  if (!id) return;
  const profile = asJson(user.profile);
  await withClient((c) =>
    c.query(
      `INSERT INTO group_chat_members
         (doco_id, chat_user_id, display_name, real_name, avatar_url, is_bot, deactivated)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (doco_id, chat_user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         real_name = EXCLUDED.real_name,
         avatar_url = EXCLUDED.avatar_url,
         is_bot = EXCLUDED.is_bot,
         deactivated = EXCLUDED.deactivated`,
      [
        docoId,
        id,
        str(profile.display_name) || str(profile.real_name) || str(user.name),
        str(profile.real_name) || str(user.real_name),
        str(profile.image_72) || null,
        user.is_bot === true,
        user.deleted === true,
      ],
    ),
  );
}

function asJson(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
