// A person's progress through the three onboarding steps the dashboard shows:
// create a workspace, connect an agent, connect sources of knowledge. Each
// step reads as done from what the database already holds, so there is no
// onboarding state of its own to keep in sync.

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface OnboardingProgress {
  /** Belongs to at least one workspace. */
  workspace: boolean;
  /** Holds a live agent connection (an unrevoked, unexpired OAuth grant). */
  agent: boolean;
  /** A workspace they belong to copies from GitHub, Slack or Notion. */
  sources: boolean;
}

export async function loadOnboardingProgress(
  c: QueryClient,
  userId: string,
): Promise<OnboardingProgress> {
  const { rows } = await c.query<OnboardingProgress>(
    `SELECT
       EXISTS (SELECT 1 FROM workspace_users WHERE user_id = $1) AS workspace,
       EXISTS (
         SELECT 1 FROM oauth_refresh_tokens
          WHERE user_id = $1 AND NOT revoked AND expires_at > now()
       ) AS agent,
       EXISTS (
         SELECT 1
           FROM workspace_users wu
          WHERE wu.user_id = $1
            AND (
              EXISTS (
                SELECT 1 FROM group_chat_installations i
                 WHERE i.doco_workspace_id = wu.workspace_id
              )
              OR EXISTS (
                SELECT 1 FROM docos d
                 WHERE d.workspace_id = wu.workspace_id
                   AND d.deleted_at IS NULL
                   AND (
                     d.data ? 'github_integration'
                     OR EXISTS (SELECT 1 FROM notion_mirrors n WHERE n.doco_id = d.id)
                   )
              )
            )
       ) AS sources`,
    [userId],
  );
  const row = rows[0];
  return { workspace: row.workspace, agent: row.agent, sources: row.sources };
}
