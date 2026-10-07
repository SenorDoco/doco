// Getting a workspace going. Its owners walk four steps on its page: connect
// GitHub, connect other sources of knowledge (or skip them), connect Doco to
// their agent, ask their agent to start using Doco, which also turns on the
// Doco hook. Everyone else in it walks only the last two. The workspace page
// (and its card on the list) keeps the person on the first step not done
// until every one is. Whoever creates a workspace or joins it from an invite
// gets a reminder email 15 minutes later if a step is still open.
//
// Each step reads as done from what the database already holds:
//   github  — a Doco in the workspace is connected to a GitHub repository or
//             organization;
//   sources — the person finished the step (with what they connected) or
//             skipped it, or agents already work in the workspace (a
//             workspace that far along is past connecting its sources);
//   mcp     — the person approved an agent's connection that reaches the
//             workspace and hasn't been revoked or run out, or their agent
//             already read or wrote in it;
//   agent   — the person's agent wrote into the workspace's Agents chats Doco
//             (the instructions ask it to note there that it got them), and
//             their Doco hook is on: a project token they made for the
//             workspace, not revoked, has been used (the agent gets it with
//             doco_hook_token), or they said their agent doesn't run hooks
//             (decision_01M4C2JDN3EZMA2FR8JPPMT7NN).
// Every member of a workspace walks them, except in their personal workspace
// (named after them), which isn't a project's. workspace_onboarding holds what
// nothing else records: who created the workspace or joined it from an invite,
// when (the reminder's clock), and when they ended the other-sources step and
// the hook themselves. A member without a row (in a workspace made before the
// steps, or added another way) walks them by role, and never gets a reminder.

import { byAgentOverApiSql } from "./authoring-provenance";
import {
  type JoinedAs,
  ONBOARDING_STEPS,
  type OnboardingStep,
  type StepState,
  pendingStep,
} from "./onboarding-steps";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** How long after the start the reminder email waits for the steps. */
export const REMINDER_DELAY_MINUTES = 15;

export interface OnboardingProgress {
  workspaceId: string;
  workspaceHandle: string;
  userId: string;
  joinedAs: JoinedAs;
  /** The person's steps in order, each with whether it is done. */
  steps: StepState[];
  /** What the agent step waits for: the agent's note, and the person's hook. */
  agent: { wrote: boolean; hook: boolean };
}

/** Start walking a workspace's steps. A person already walking them keeps
 *  their row: joining again from an invite never restarts a creator's steps. */
export async function startOnboarding(
  c: QueryClient,
  opts: { workspaceId: string; userId: string; joinedAs: JoinedAs },
): Promise<void> {
  await c.query(
    `INSERT INTO workspace_onboarding (workspace_id, user_id, joined_as)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [opts.workspaceId, opts.userId, opts.joinedAs],
  );
}

/** What a person ends themselves, each with the column that says when. */
const ENDED_BY_THE_PERSON = { sources: "sources_done_at", hook: "hook_done_at" } as const;

/** End the other-sources step (with whatever was connected, or nothing) or
 *  the hook (their agent doesn't run hooks). A member without a row walks
 *  the steps by role, which the row it adds keeps; it counts as reminded,
 *  since nobody started the steps to be reminded of. */
export async function finishStep(
  c: QueryClient,
  opts: { workspaceId: string; userId: string; step: keyof typeof ENDED_BY_THE_PERSON },
): Promise<void> {
  const column = ENDED_BY_THE_PERSON[opts.step];
  await c.query(
    `INSERT INTO workspace_onboarding
       (workspace_id, user_id, joined_as, ${column}, reminded_at)
     SELECT workspace_id, user_id,
            CASE WHEN role = 'owner' THEN 'creator' ELSE 'invitee' END, now(), now()
       FROM workspace_users
      WHERE workspace_id = $1 AND user_id = $2
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET ${column} = COALESCE(workspace_onboarding.${column}, now())`,
    [opts.workspaceId, opts.userId],
  );
}

// A GitHub connection is a repository or a whole organization on any live Doco
// of the workspace. An agent is anyone working over the MCP server or the API
// (never the website, Slack or Doco's own imports, such as GitHub's): any
// agent's read or write in the workspace finishes the other sources, and the
// person's own finishes connecting Doco to their agent, as does a connection
// they approved (an OAuth refresh token reaching every workspace of theirs,
// this one, or a Doco in it); the agent step needs the person's own agent to
// write in one of the workspace's Agents chats Docos.
function agentWorkedSql(byThePerson = false): string {
  const by = byThePerson ? " AND cs.actor = wu.user_id" : "";
  const queriedBy = byThePerson ? " AND q.actor = wu.user_id" : "";
  return `(EXISTS (
             SELECT 1 FROM changesets cs
               JOIN docos d ON d.id = cs.doco_id
              WHERE d.workspace_id = wu.workspace_id
                AND d.deleted_at IS NULL${by}
                AND ${byAgentOverApiSql("cs")}
           )
           OR EXISTS (
             SELECT 1 FROM query_events q
              WHERE q.workspace_id = wu.workspace_id${queriedBy}
                AND ${byAgentOverApiSql("q")}
           ))`;
}

const PROGRESS_SQL = `
  SELECT wu.workspace_id, w.handle AS workspace_handle, wu.user_id,
         COALESCE(o.joined_as, CASE WHEN wu.role = 'owner' THEN 'creator' ELSE 'invitee' END)
           AS joined_as,
         EXISTS (
           SELECT 1 FROM docos d
            WHERE d.workspace_id = wu.workspace_id
              AND d.deleted_at IS NULL
              AND (COALESCE(d.data->'github_integration'->'connections', '[]'::jsonb) <> '[]'::jsonb
                OR COALESCE(d.data->'github_integration'->'installations', '[]'::jsonb) <> '[]'::jsonb)
         ) AS github,
         o.sources_done_at IS NOT NULL OR ${agentWorkedSql()} AS sources,
         EXISTS (
           SELECT 1 FROM oauth_refresh_tokens rt
            WHERE rt.user_id = wu.user_id
              AND NOT rt.revoked
              AND rt.expires_at > now()
              AND (rt.grant_type = 'actor'
                OR wu.workspace_id = ANY (rt.granted_workspace_ids)
                OR EXISTS (
                  SELECT 1 FROM docos d
                   WHERE d.id = ANY (rt.granted_doco_ids)
                     AND d.workspace_id = wu.workspace_id
                     AND d.deleted_at IS NULL
                ))
         ) OR ${agentWorkedSql(true)} AS mcp,
         EXISTS (
           SELECT 1 FROM changesets cs
             JOIN docos d ON d.id = cs.doco_id
            WHERE d.workspace_id = wu.workspace_id
              AND d.deleted_at IS NULL
              AND d.data->>'template_handle' = 'agents-chats'
              AND cs.actor = wu.user_id
              AND ${byAgentOverApiSql("cs")}
         ) AS wrote,
         o.hook_done_at IS NOT NULL OR EXISTS (
           SELECT 1 FROM project_tokens pt
            WHERE pt.workspace_id = wu.workspace_id
              AND pt.created_by_user_id = wu.user_id
              AND NOT pt.revoked
              AND pt.last_used_at IS NOT NULL
         ) AS hook
    FROM workspace_users wu
    JOIN workspaces w ON w.id = wu.workspace_id
    JOIN users u ON u.id = wu.user_id
    LEFT JOIN workspace_onboarding o
      ON o.workspace_id = wu.workspace_id AND o.user_id = wu.user_id
   WHERE lower(w.handle) <> lower(COALESCE(u.github_login, ''))`;

interface ProgressRow {
  workspace_id: string;
  workspace_handle: string;
  user_id: string;
  joined_as: JoinedAs;
  github: boolean;
  sources: boolean;
  mcp: boolean;
  wrote: boolean;
  hook: boolean;
}

function toProgress(row: ProgressRow): OnboardingProgress {
  const done: Record<OnboardingStep, boolean> = {
    github: row.github,
    sources: row.sources,
    mcp: row.mcp,
    agent: row.wrote && row.hook,
  };
  return {
    workspaceId: row.workspace_id,
    workspaceHandle: row.workspace_handle,
    userId: row.user_id,
    joinedAs: row.joined_as,
    steps: ONBOARDING_STEPS[row.joined_as].map((step) => ({ step, done: done[step] })),
    agent: { wrote: row.wrote, hook: row.hook },
  };
}

/** Where a person stands in one workspace's steps; null when they aren't in
 *  it, or it's their personal workspace. */
export async function loadOnboardingProgress(
  c: QueryClient,
  opts: { workspaceId: string; userId: string },
): Promise<OnboardingProgress | null> {
  const { rows } = await c.query<ProgressRow>(
    `${PROGRESS_SQL} AND wu.workspace_id = $1 AND wu.user_id = $2`,
    [opts.workspaceId, opts.userId],
  );
  return rows[0] ? toProgress(rows[0]) : null;
}

/** Every workspace whose steps a person hasn't finished, by workspace id. */
export async function loadUnfinishedOnboarding(
  c: QueryClient,
  userId: string,
): Promise<Map<string, OnboardingProgress>> {
  const { rows } = await c.query<ProgressRow>(`${PROGRESS_SQL} AND wu.user_id = $1`, [userId]);
  return new Map(
    rows
      .map(toProgress)
      .filter((p) => pendingStep(p) !== null)
      .map((p) => [p.workspaceId, p]),
  );
}

export interface DueReminder {
  progress: OnboardingProgress;
  email: string | null;
}

/**
 * Claim every reminder that has come due: a workspace created or joined from an
 * invite at least 15 minutes ago (and less than a day ago, so a reminder never arrives days late) with no
 * reminder sent. Claiming marks each sent, so two sweeps never both send one;
 * it returns those whose steps are still open, with the person's email.
 */
export async function claimDueReminders(c: QueryClient, now: Date): Promise<DueReminder[]> {
  const claimed = await c.query<{ workspace_id: string; user_id: string }>(
    `UPDATE workspace_onboarding
        SET reminded_at = $1
      WHERE reminded_at IS NULL
        AND started_at <= $1::timestamptz - make_interval(mins => $2)
        AND started_at > $1::timestamptz - interval '1 day'
      RETURNING workspace_id, user_id`,
    [now.toISOString(), REMINDER_DELAY_MINUTES],
  );
  const due: DueReminder[] = [];
  for (const { workspace_id, user_id } of claimed.rows) {
    const progress = await loadOnboardingProgress(c, {
      workspaceId: workspace_id,
      userId: user_id,
    });
    if (!progress || pendingStep(progress) === null) continue;
    const user = await c.query<{ email: string | null }>(
      "SELECT email FROM users WHERE id = $1 AND deactivated_at IS NULL",
      [user_id],
    );
    due.push({ progress, email: user.rows[0]?.email || null });
  }
  return due;
}
