// A person's progress through the three onboarding steps the dashboard shows:
// create a workspace, connect an agent, connect sources of knowledge. Each
// step reads as done from what the database already holds, so there is no
// onboarding state of its own to keep in sync.

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface OnboardingProgress {
  /** Created or joined a project's workspace, or was invited to one of its Docos. */
  workspace: boolean;
  /** Holds a live agent connection (an unrevoked, unexpired OAuth grant). */
  agent: boolean;
  /** One of those workspaces copies from GitHub, Slack or Notion. */
  sources: boolean;
}

// Every person gets a personal workspace named after them at sign-up
// (ensurePersonalWorkspace). It is not a project's workspace, so it doesn't
// count; a Doco invite brings in the Doco's workspace.
export async function loadOnboardingProgress(
  c: QueryClient,
  userId: string,
): Promise<OnboardingProgress> {
  const { rows } = await c.query<OnboardingProgress>(
    `WITH project_workspaces AS (
       SELECT wu.workspace_id
         FROM workspace_users wu
         JOIN workspaces w ON w.id = wu.workspace_id
         JOIN users u ON u.id = wu.user_id
        WHERE wu.user_id = $1
          AND LOWER(w.handle) <> LOWER(COALESCE(u.github_login, ''))
       UNION
       SELECT d.workspace_id
         FROM doco_users du
         JOIN docos d ON d.id = du.doco_id
        WHERE du.user_id = $1 AND d.deleted_at IS NULL
     )
     SELECT
       EXISTS (SELECT 1 FROM project_workspaces) AS workspace,
       EXISTS (
         SELECT 1 FROM oauth_refresh_tokens
          WHERE user_id = $1 AND NOT revoked AND expires_at > now()
       ) AS agent,
       EXISTS (
         SELECT 1
           FROM project_workspaces pw
          WHERE EXISTS (
                  SELECT 1 FROM group_chat_installations i
                   WHERE i.doco_workspace_id = pw.workspace_id
                )
             OR EXISTS (
                  SELECT 1 FROM docos d
                   WHERE d.workspace_id = pw.workspace_id
                     AND d.deleted_at IS NULL
                     AND (
                       d.data ? 'github_integration'
                       OR EXISTS (SELECT 1 FROM notion_mirrors n WHERE n.doco_id = d.id)
                     )
                )
       ) AS sources`,
    [userId],
  );
  const row = rows[0];
  return { workspace: row.workspace, agent: row.agent, sources: row.sources };
}
