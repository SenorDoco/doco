// Getting a workspace going. Whoever creates a workspace walks three steps on
// its page: connect GitHub, connect other sources of knowledge (or skip them),
// ask their agent to start using Doco. Whoever joins it from an invite walks
// only the last. The workspace page keeps the person on the first step not
// done until every one is, and a reminder email goes out 15 minutes after the
// start if one is still open.
//
// Each step reads as done from what the database already holds:
//   github  — a Doco in the workspace is connected to a GitHub repository or
//             organization;
//   sources — the person finished the step (with what they connected) or
//             skipped it, the one thing nothing else records;
//   agent   — the person's agent wrote into the workspace's Agents chats Doco
//             (the instructions ask it to note there that it got them).
// workspace_onboarding holds a row per person walking the steps; a workspace
// made before onboarding existed has none, so its people never see it.

import { type JoinedAs, ONBOARDING_STEPS, type StepState, pendingStep } from "./onboarding-steps";

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
  startedAt: string;
  /** The person's steps in order, each with whether it is done. */
  steps: StepState[];
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

/** Finish the other-sources step, with whatever was connected or nothing. */
export async function finishSourcesStep(
  c: QueryClient,
  opts: { workspaceId: string; userId: string },
): Promise<void> {
  await c.query(
    `UPDATE workspace_onboarding
        SET sources_done_at = now()
      WHERE workspace_id = $1 AND user_id = $2 AND sources_done_at IS NULL`,
    [opts.workspaceId, opts.userId],
  );
}

// A GitHub connection is a repository or a whole organization on any live Doco
// of the workspace. An agent's write is a changeset it made on the person's
// behalf (over the MCP server or the API, never the website, Slack or an
// import) in one of the workspace's Agents chats Docos.
const PROGRESS_SQL = `
  SELECT o.workspace_id, w.handle AS workspace_handle, o.user_id, o.joined_as, o.started_at,
         EXISTS (
           SELECT 1 FROM docos d
            WHERE d.workspace_id = o.workspace_id
              AND d.deleted_at IS NULL
              AND (COALESCE(d.data->'github_integration'->'connections', '[]'::jsonb) <> '[]'::jsonb
                OR COALESCE(d.data->'github_integration'->'installations', '[]'::jsonb) <> '[]'::jsonb)
         ) AS github,
         o.sources_done_at IS NOT NULL AS sources,
         EXISTS (
           SELECT 1 FROM changesets cs
             JOIN docos d ON d.id = cs.doco_id
            WHERE d.workspace_id = o.workspace_id
              AND d.deleted_at IS NULL
              AND d.data->>'template_handle' = 'agents-chats'
              AND cs.actor = o.user_id
              AND cs.source IN ('api', 'mcp')
         ) AS agent
    FROM workspace_onboarding o
    JOIN workspaces w ON w.id = o.workspace_id`;

interface ProgressRow {
  workspace_id: string;
  workspace_handle: string;
  user_id: string;
  joined_as: JoinedAs;
  started_at: Date | string;
  github: boolean;
  sources: boolean;
  agent: boolean;
}

function toProgress(row: ProgressRow): OnboardingProgress {
  return {
    workspaceId: row.workspace_id,
    workspaceHandle: row.workspace_handle,
    userId: row.user_id,
    joinedAs: row.joined_as,
    startedAt: new Date(row.started_at).toISOString(),
    steps: ONBOARDING_STEPS[row.joined_as].map((step) => ({ step, done: row[step] })),
  };
}

/** Where a person stands in one workspace's steps; null when they never
 *  started them there. */
export async function loadOnboardingProgress(
  c: QueryClient,
  opts: { workspaceId: string; userId: string },
): Promise<OnboardingProgress | null> {
  const { rows } = await c.query<ProgressRow>(
    `${PROGRESS_SQL} WHERE o.workspace_id = $1 AND o.user_id = $2`,
    [opts.workspaceId, opts.userId],
  );
  return rows[0] ? toProgress(rows[0]) : null;
}

/** Every workspace whose steps a person hasn't finished, by workspace id. */
export async function loadUnfinishedOnboarding(
  c: QueryClient,
  userId: string,
): Promise<Map<string, OnboardingProgress>> {
  const { rows } = await c.query<ProgressRow>(`${PROGRESS_SQL} WHERE o.user_id = $1`, [userId]);
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
 * Claim every reminder that has come due: steps started at least 15 minutes
 * ago (and less than a day ago, so a reminder never arrives days late) with no
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
