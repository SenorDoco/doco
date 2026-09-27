// What an integrated Doco reports about each source it copies from — GitHub
// pull requests, a Slack workspace: how live the copy is (when the newest item
// copied was created or last changed) and how far the import of older items
// has got. The Doco home shows it atop the activity column; the Doco's
// integrations page summarizes it.
import {
  IMPORT_STALL_MINUTES,
  type ImportState,
  githubImportState,
} from "./github-connection.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type { ImportState };

export interface GitHubIntegrationStatus {
  integration: "github";
  /** When the most recently changed PR Reference was written. */
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

export type IntegrationStatus = GitHubIntegrationStatus | SlackIntegrationStatus;

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
  return statuses;
}

async function loadGitHubStatus(
  c: QueryClient,
  docoId: string,
  now: Date,
): Promise<GitHubIntegrationStatus | null> {
  const raw = (
    await c.query<{ gh: unknown }>(
      "SELECT data->'github_integration' AS gh FROM docos WHERE id = $1",
      [docoId],
    )
  ).rows[0]?.gh;
  const imported = githubImportState(raw ?? null, now.getTime());
  if (!imported) return null;
  const latest = (
    await c.query<{ at: Date | string | null }>(
      `SELECT max(updated_at) AS at FROM nodes
        WHERE doco_id = $1 AND node_type = 'reference'
          AND locator LIKE 'https://github.com/%/pull/%'`,
      [docoId],
    )
  ).rows[0]?.at;
  return { integration: "github", latestAt: toIso(latest), ...imported };
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

function toIso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function slackTsToIso(ts: string | null): string | null {
  return ts ? new Date(Number(ts) * 1000).toISOString() : null;
}
