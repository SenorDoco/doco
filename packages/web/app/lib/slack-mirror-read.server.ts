// Reading the Slack public-channel mirror: the Doco home's Slack perspective
// (channels → messages → threads) and Slack results in the Doco's search.
// Search is hybrid: full-text over the messages fused with the nearest
// embedded ones when the caller brings a query embedding. Everything here is
// scoped to one Doco; callers have already checked that the viewer can read it.
import { type SemanticQuery, rankEmbeddings } from "@doco/db";
import { fuseRankings } from "./rank-fusion";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface SlackReaderFile {
  name: string;
  permalink: string | null;
}

export interface SlackReaderMessage {
  channelId: string;
  channelName: string;
  ts: string;
  threadTs: string | null;
  author: string;
  avatarUrl: string | null;
  /** Mentions, channel links, and URLs rendered as readable text. */
  text: string;
  postedAt: string;
  files: SlackReaderFile[];
  permalink: string;
  /** Replies copied so far (a thread's first `repliesPerThread` are loaded). */
  replyCount: number;
  replies: SlackReaderMessage[];
}

export interface SlackPerspectiveData {
  teamDomain: string;
  channels: { channelId: string; name: string; archived: boolean; lastPostedAt: string | null }[];
  /** The channel being read (null while searching or with no channels). */
  channelId: string | null;
  /** The active search, "" when browsing a channel. */
  query: string;
  messages: SlackReaderMessage[];
  /** Pass as `before` to page to older messages; null when there are none. */
  olderBefore: string | null;
}

export interface SlackSearchHit {
  type: "slack_message";
  channel: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  author: string;
  posted_at: string;
  text: string;
  permalink: string;
}

/** Slack mrkdwn → readable text: `<@U1>` → `@Name`, `<#C1|eng>` → `#eng`,
 *  `<!here>` → `@here`, `<url|label>` → `label (url)`, entities decoded. Pure. */
export function renderSlackText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([^|>]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => {
      return `@${names.get(id) ?? label ?? id}`;
    })
    .replace(/<#([^|>]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `#${name || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, who: string) => `@${who}`)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_m, url: string) => url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** What a message embeds as: its channel and author, then its text with
 *  mentions rendered. Empty for a message with no text (a file alone). Pure. */
export function slackMessageText(
  channel: string,
  author: string,
  text: string,
  names: Map<string, string>,
): string {
  const body = renderSlackText(text, names).trim();
  if (!body) return "";
  return `#${channel} — ${author || "unknown"}: ${body}`;
}

/** The message's link in Slack (a reply links within its thread). Pure. */
export function slackPermalink(
  teamDomain: string,
  channelId: string,
  ts: string,
  threadTs: string | null,
): string {
  const base = `https://${teamDomain}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

interface MessageRow {
  channel_id: string;
  channel_name: string;
  ts: string;
  thread_ts: string | null;
  author_id: string | null;
  text: string;
  files: unknown;
  posted_at: Date | string;
}

const MESSAGE_COLUMNS = `m.channel_id, ch.name AS channel_name, m.ts, m.thread_ts, m.author_id,
       m.text, m.files, m.posted_at`;
const MESSAGE_FROM = `group_chat_messages m
  JOIN group_chat_channels ch ON ch.doco_id = m.doco_id AND ch.channel_id = m.channel_id`;

interface MirrorContext {
  teamDomain: string;
  members: Map<string, { name: string; avatarUrl: string | null }>;
}

async function loadMirrorContext(c: QueryClient, docoId: string): Promise<MirrorContext | null> {
  const mirror = (
    await c.query<{ team_domain: string }>(
      "SELECT team_domain FROM group_chat_mirrors WHERE doco_id = $1",
      [docoId],
    )
  ).rows[0];
  if (!mirror) return null;
  const members = new Map<string, { name: string; avatarUrl: string | null }>();
  for (const row of (
    await c.query<{
      chat_user_id: string;
      display_name: string;
      real_name: string;
      avatar_url: string | null;
    }>(
      `SELECT chat_user_id, display_name, real_name, avatar_url
         FROM group_chat_members WHERE doco_id = $1`,
      [docoId],
    )
  ).rows) {
    members.set(row.chat_user_id, {
      name: row.display_name || row.real_name || row.chat_user_id,
      avatarUrl: row.avatar_url,
    });
  }
  return { teamDomain: mirror.team_domain, members };
}

function toReaderMessage(row: MessageRow, ctx: MirrorContext): SlackReaderMessage {
  const names = new Map([...ctx.members].map(([id, m]) => [id, m.name]));
  const member = row.author_id ? ctx.members.get(row.author_id) : undefined;
  const files = Array.isArray(row.files) ? (row.files as Record<string, unknown>[]) : [];
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    ts: row.ts,
    threadTs: row.thread_ts,
    author: member?.name ?? row.author_id ?? "unknown",
    avatarUrl: member?.avatarUrl ?? null,
    text: renderSlackText(row.text, names),
    postedAt: new Date(row.posted_at).toISOString(),
    files: files.map((f) => ({
      name: String(f.name ?? "file"),
      permalink: typeof f.permalink === "string" ? f.permalink : null,
    })),
    permalink: slackPermalink(ctx.teamDomain, row.channel_id, row.ts, row.thread_ts),
    replyCount: 0,
    replies: [],
  };
}

/**
 * Messages matching the query across the mirror's channels, best first: the
 * full-text ranking fused by reciprocal rank with the nearest embedded
 * messages when the caller brings a query embedding.
 */
async function matchingMessages(
  c: QueryClient,
  docoId: string,
  query: string,
  limit: number,
  semantic: SemanticQuery | null,
): Promise<MessageRow[]> {
  const byWords = (
    await c.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM ${MESSAGE_FROM}, websearch_to_tsquery('simple', $2) q
        WHERE m.doco_id = $1 AND NOT ch.excluded AND m.search_tsv @@ q
        ORDER BY ts_rank_cd(m.search_tsv, q) DESC, m.ts DESC
        LIMIT $3`,
      [docoId, query, limit],
    )
  ).rows;
  const byMeaning = semantic
    ? await rankEmbeddings(c, {
        docoIds: [docoId],
        source: "slack",
        modelId: semantic.modelId,
        queryEmbedding: semantic.queryEmbedding,
        limit,
      })
    : [];
  const key = (row: MessageRow) => `${row.channel_id}:${row.ts}`;
  const order = fuseRankings([byMeaning.map((hit) => hit.entity_id), byWords.map(key)]).slice(
    0,
    limit,
  );
  const rows = new Map(byWords.map((row) => [key(row), row]));
  const missing = order.filter((id) => !rows.has(id));
  if (missing.length > 0) {
    for (const row of (
      await c.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
           FROM ${MESSAGE_FROM}
          WHERE m.doco_id = $1 AND NOT ch.excluded
            AND (m.channel_id || ':' || m.ts) = ANY($2::text[])`,
        [docoId, missing],
      )
    ).rows) {
      rows.set(key(row), row);
    }
  }
  return order.flatMap((id) => rows.get(id) ?? []);
}

export async function loadSlackPerspective(
  c: QueryClient,
  docoId: string,
  opts: {
    channelId?: string | null;
    before?: string | null;
    query?: string | null;
    limit?: number;
    repliesPerThread?: number;
    semantic?: SemanticQuery | null;
  },
): Promise<SlackPerspectiveData> {
  const query = opts.query?.trim() ?? "";
  const ctx = await loadMirrorContext(c, docoId);
  if (!ctx) {
    return {
      teamDomain: "",
      channels: [],
      channelId: null,
      query,
      messages: [],
      olderBefore: null,
    };
  }
  const limit = opts.limit ?? 50;
  const channels = (
    await c.query<{ channel_id: string; name: string; archived: boolean; last_ts: string | null }>(
      `SELECT ch.channel_id, ch.name, ch.archived,
              (SELECT max(m.ts) FROM group_chat_messages m
                WHERE m.doco_id = ch.doco_id AND m.channel_id = ch.channel_id) AS last_ts
         FROM group_chat_channels ch
        WHERE ch.doco_id = $1 AND NOT ch.excluded
        ORDER BY last_ts DESC NULLS LAST, ch.name`,
      [docoId],
    )
  ).rows.map((row) => ({
    channelId: row.channel_id,
    name: row.name,
    archived: row.archived,
    lastPostedAt: row.last_ts ? new Date(Number(row.last_ts) * 1000).toISOString() : null,
  }));

  if (query) {
    const rows = await matchingMessages(c, docoId, query, limit, opts.semantic ?? null);
    return {
      teamDomain: ctx.teamDomain,
      channels,
      channelId: null,
      query,
      messages: rows.map((row) => toReaderMessage(row, ctx)),
      olderBefore: null,
    };
  }

  const channelId =
    channels.find((ch) => ch.channelId === opts.channelId)?.channelId ??
    channels[0]?.channelId ??
    null;
  if (!channelId) {
    return {
      teamDomain: ctx.teamDomain,
      channels,
      channelId,
      query,
      messages: [],
      olderBefore: null,
    };
  }
  const topLevel = (
    await c.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM ${MESSAGE_FROM}
        WHERE m.doco_id = $1 AND m.channel_id = $2
          AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
          AND ($3::text IS NULL OR m.ts < $3::text)
        ORDER BY m.ts DESC
        LIMIT $4`,
      [docoId, channelId, opts.before ?? null, limit + 1],
    )
  ).rows;
  const page = topLevel.slice(0, limit);
  const messages = page.map((row) => toReaderMessage(row, ctx));
  const roots = messages.filter((m) => m.threadTs === m.ts).map((m) => m.ts);
  if (roots.length > 0) {
    const replies = (
      await c.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
           FROM ${MESSAGE_FROM}
          WHERE m.doco_id = $1 AND m.channel_id = $2
            AND m.thread_ts = ANY($3::text[]) AND m.ts <> m.thread_ts
          ORDER BY m.ts`,
        [docoId, channelId, roots],
      )
    ).rows;
    const byRoot = new Map(messages.map((m) => [m.ts, m]));
    const perThread = opts.repliesPerThread ?? 20;
    for (const row of replies) {
      const root = row.thread_ts ? byRoot.get(row.thread_ts) : undefined;
      if (!root) continue;
      root.replyCount++;
      if (root.replies.length < perThread) root.replies.push(toReaderMessage(row, ctx));
    }
  }
  return {
    teamDomain: ctx.teamDomain,
    channels,
    channelId,
    query,
    messages,
    olderBefore: topLevel.length > limit ? (page.at(-1)?.ts ?? null) : null,
  };
}

/** Slack messages matching `query`, for the Doco's search results. Empty for
 *  a Doco that doesn't mirror Slack. */
export async function searchSlackMirror(
  c: QueryClient,
  docoId: string,
  query: string,
  limit: number,
  semantic: SemanticQuery | null = null,
): Promise<SlackSearchHit[]> {
  const ctx = await loadMirrorContext(c, docoId);
  if (!ctx || !query.trim()) return [];
  const rows = await matchingMessages(c, docoId, query, limit, semantic);
  return rows.map((row) => {
    const message = toReaderMessage(row, ctx);
    return {
      type: "slack_message",
      channel: message.channelName,
      channel_id: message.channelId,
      ts: message.ts,
      thread_ts: message.threadTs,
      author: message.author,
      posted_at: message.postedAt,
      text: message.text.length > 500 ? `${message.text.slice(0, 500)}…` : message.text,
      permalink: message.permalink,
    };
  });
}
