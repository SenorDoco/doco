// What an integrated Doco reports about each source it copies from — GitHub
// pull requests, bugs or code, a Slack workspace, a Notion workspace: how live the copy is
// (when the newest item copied was created or last changed) and how far the
// import of older items has got, or, for a Doco made to fill from a source,
// that nobody has connected it yet. The Doco home shows it atop the activity
// column; the Doco's integrations page summarizes it.
import {
  IMPORT_STALL_MINUTES,
  type ImportState,
  githubImportState,
} from "./github-connection.server";
import { githubImportFor } from "./github-imports";
import { type SourceIntegration, sourceIntegrationFor } from "./integrations-catalog";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type { ImportState };

export interface GitHubIntegrationStatus {
  integration: "github";
  /** What the Doco brings from GitHub, one and several (github-imports). */
  item: string;
  items: string;
  /** When the most recently changed item copied from GitHub was written. */
  latestAt: string | null;
  state: ImportState;
  reposDone: number;
  repos: number;
}

export interface SlackIntegrationStatus {
  integration: "slack";
  teamName: string;
  /** When the newest copied message was posted in Slack. */
  latestAt: string | null;
  state: ImportState;
  /** How far back every channel is copied; null while a channel hasn't started. */
  backTo: string | null;
  /** The date the history copy goes back to. */
  since: string;
  channelsDone: number;
  channels: number;
  /** Threads whose earlier replies are still to be copied. */
  threadsPending: number;
}

export interface NotionIntegrationStatus {
  integration: "notion";
  workspaceName: string;
  /** When the newest copied page was last edited in Notion. */
  latestAt: string | null;
  state: ImportState;
  /** Notion no longer accepts the token: an owner must reconnect. */
  needsReauth: boolean;
  /** Objects copied at least once, of those discovered. */
  pagesDone: number;
  pages: number;
  /** Notion capped the page listing: the count grows as the pages found
   *  through the pages that name them are copied. */
  listingCapped: boolean;
}

/** A Doco made to fill from a source nobody has connected yet: it stays empty
 *  until someone does. */
export interface UnconnectedIntegrationStatus {
  integration: SourceIntegration;
  state: "unconnected";
}

export type ConnectedIntegrationStatus =
  | GitHubIntegrationStatus
  | SlackIntegrationStatus
  | NotionIntegrationStatus;

export type IntegrationStatus = ConnectedIntegrationStatus | UnconnectedIntegrationStatus;

const STALL_MS = IMPORT_STALL_MINUTES * 60_000;

export async function loadIntegrationStatuses(
  c: QueryClient,
  docoId: string,
  now: Date = new Date(),
): Promise<IntegrationStatus[]> {
  const statuses: IntegrationStatus[] = [];
  const github = await loadGitHubStatus(c, docoId, now);
  if (github) statuses.push(github);
  const slack = await loadSlackStatus(c, docoId, now);
  if (slack) statuses.push(slack);
  const notion = await loadNotionStatus(c, docoId, now);
  if (notion) statuses.push(notion);
  const template = (
    await c.query<{ template: string | null }>(
      "SELECT data->>'template_handle' AS template FROM docos WHERE id = $1",
      [docoId],
    )
  ).rows[0]?.template;
  const source = sourceIntegrationFor(template);
  if (source && !statuses.some((s) => s.integration === source)) {
    statuses.unshift({ integration: source, state: "unconnected" });
  }
  return statuses;
}

async function loadGitHubStatus(
  c: QueryClient,
  docoId: string,
  now: Date,
): Promise<GitHubIntegrationStatus | null> {
  const doco = (
    await c.query<{ gh: unknown; template: string | null }>(
      `SELECT data->'github_integration' AS gh, data->>'template_handle' AS template
         FROM docos WHERE id = $1`,
      [docoId],
    )
  ).rows[0];
  const imported = githubImportState(doco?.gh ?? null, now.getTime());
  if (!imported) return null;
  // A pull request's Reference, a bug issue's Eval or a copied code file:
  // whatever came from GitHub.
  const latest = (
    await c.query<{ at: Date | string | null }>(
      `SELECT greatest(
                (SELECT max(updated_at) FROM nodes
                  WHERE doco_id = $1 AND node_type IN ('reference', 'eval')
                    AND locator ~ '^https://github\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+$'),
                (SELECT max(synced_at) FROM code_files WHERE doco_id = $1)) AS at`,
      [docoId],
    )
  ).rows[0]?.at;
  const { item, items } = githubImportFor(doco?.template);
  return { integration: "github", item, items, latestAt: toIso(latest), ...imported };
}

async function loadSlackStatus(
  c: QueryClient,
  docoId: string,
  now: Date,
): Promise<SlackIntegrationStatus | null> {
  const mirror = (
    await c.query<{
      workspace_name: string;
      team_domain: string;
      history_since: Date | string;
      consented_at: Date | string;
      heartbeat: Date | string | null;
    }>(
      `SELECT i.workspace_name, m.team_domain, m.history_since, m.consented_at,
              greatest(m.history_next_at, m.replies_next_at) AS heartbeat
         FROM group_chat_mirrors m
         JOIN group_chat_installations i ON i.id = m.installation_id
        WHERE m.doco_id = $1`,
      [docoId],
    )
  ).rows[0];
  if (!mirror) return null;
  // The channels the history copy walks: joined ones, and those still to be
  // joined (archived channels can't be joined, so they're never copied).
  const channels = (
    await c.query<{
      channels: number;
      done: number;
      unstarted: boolean | null;
      back_to: string | null;
      latest_ts: string | null;
    }>(
      `SELECT count(*)::int AS channels,
              count(*) FILTER (WHERE history_done_at IS NOT NULL)::int AS done,
              bool_or(history_done_at IS NULL AND history_oldest_ts IS NULL) AS unstarted,
              max(history_oldest_ts::numeric) FILTER (WHERE history_done_at IS NULL)::text
                AS back_to,
              max(latest_ts::numeric)::text AS latest_ts
         FROM (SELECT ch.history_done_at, ch.history_oldest_ts,
                      (SELECT max(m.ts) FROM group_chat_messages m
                        WHERE m.doco_id = ch.doco_id AND m.channel_id = ch.channel_id) AS latest_ts
                 FROM group_chat_channels ch
                WHERE ch.doco_id = $1 AND NOT ch.excluded
                  AND (ch.joined_at IS NOT NULL OR NOT ch.archived)) ch`,
      [docoId],
    )
  ).rows[0];
  const threadsPending = Number(
    (
      await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM group_chat_messages m
           JOIN group_chat_channels ch ON ch.doco_id = m.doco_id AND ch.channel_id = m.channel_id
          WHERE m.doco_id = $1 AND m.reply_count > 0 AND m.replies_synced_at IS NULL
            AND NOT ch.excluded`,
        [docoId],
      )
    ).rows[0]?.n ?? 0,
  );
  const channelCount = Number(channels?.channels ?? 0);
  const channelsDone = Number(channels?.done ?? 0);
  // Every sync run moves the next-call times forward, so the latest of them is
  // a heartbeat: none for a while (or never, since turning it on) is a stall.
  const lastRun = new Date(mirror.heartbeat ?? mirror.consented_at).getTime();
  const done = channelCount > 0 && channelsDone === channelCount && threadsPending === 0;
  return {
    integration: "slack",
    teamName: mirror.workspace_name || mirror.team_domain,
    latestAt: slackTsToIso(channels?.latest_ts ?? null),
    state: done ? "done" : now.getTime() - lastRun > STALL_MS ? "stalled" : "importing",
    backTo: channels?.unstarted ? null : slackTsToIso(channels?.back_to ?? null),
    since: new Date(mirror.history_since).toISOString(),
    channelsDone,
    channels: channelCount,
    threadsPending,
  };
}

async function loadNotionStatus(
  c: QueryClient,
  docoId: string,
  now: Date,
): Promise<NotionIntegrationStatus | null> {
  const mirror = (
    await c.query<{
      workspace_name: string;
      consented_at: Date | string;
      discovered_at: Date | string | null;
      ticked_at: Date | string | null;
      needs_reauth_at: Date | string | null;
      listing_capped_at: Date | string | null;
    }>(
      `SELECT workspace_name, consented_at, discovered_at, ticked_at, needs_reauth_at,
              listing_capped_at
         FROM notion_mirrors WHERE doco_id = $1`,
      [docoId],
    )
  ).rows[0];
  if (!mirror) return null;
  const counts = (
    await c.query<{
      pages: number;
      done: number;
      pending: number;
      latest: Date | string | null;
    }>(
      `SELECT count(*)::int AS pages,
              count(*) FILTER (WHERE synced_at IS NOT NULL)::int AS done,
              count(*) FILTER (WHERE fetch_pending)::int AS pending,
              max(last_edited_time) FILTER (WHERE synced_at IS NOT NULL) AS latest
         FROM notion_pages WHERE doco_id = $1`,
      [docoId],
    )
  ).rows[0];
  const pending = Number(counts?.pending ?? 0);
  const needsReauth = mirror.needs_reauth_at !== null;
  // Every tick stamps the heartbeat; none for a while (or never, since turning
  // it on) while pages are still waiting is a stall.
  const lastRun = new Date(mirror.ticked_at ?? mirror.consented_at).getTime();
  const finished = mirror.discovered_at !== null && pending === 0;
  return {
    integration: "notion",
    workspaceName: mirror.workspace_name,
    latestAt: toIso(counts?.latest),
    state: needsReauth
      ? "stalled"
      : finished
        ? "done"
        : now.getTime() - lastRun > STALL_MS
          ? "stalled"
          : "importing",
    needsReauth,
    pagesDone: Number(counts?.done ?? 0),
    pages: Number(counts?.pages ?? 0),
    listingCapped: mirror.listing_capped_at !== null,
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function slackTsToIso(ts: string | null): string | null {
  return ts ? new Date(Number(ts) * 1000).toISOString() : null;
}
