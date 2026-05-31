// Per-Doco GitHub connection config, stored in docos.data.github_integration.
// This is the glue the webhook (findDocoConnectionsByRepo) and backfill read:
// it records which GitHub repo + App installation a Doco is wired to. Written
// by the settings panel / connect endpoint.
import { withClient } from "@doco/db";

export interface GitHubConnection {
  /** "owner/name". */
  repo: string;
  /** GitHub App installation id covering the repo. */
  installation_id: number;
  connected_at?: string;
}

/**
 * Normalize a repo reference to `{ owner, name }`. Accepts "owner/name" or a
 * full GitHub URL (trailing `.git` / slashes tolerated). Null if malformed.
 * Pure.
 */
export function parseRepoSlug(input: string): { owner: string; name: string } | null {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** Read the Doco's GitHub connection, or null if it isn't connected. */
export async function getGitHubConnection(docoId: string): Promise<GitHubConnection | null> {
  return withClient(async (c) => {
    const r = await c.query<{ gh: GitHubConnection | null }>(
      `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
      [docoId],
    );
    return r.rows[0]?.gh ?? null;
  });
}

/** Write (upsert) the Doco's GitHub connection into docos.data.github_integration. */
export async function setGitHubConnection(docoId: string, conn: GitHubConnection): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{github_integration}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify(conn)],
    );
  });
}

/** Remove the Doco's GitHub connection (disconnect). */
export async function clearGitHubConnection(docoId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos SET data = data - 'github_integration', updated_at = now() WHERE id = $1`,
      [docoId],
    );
  });
}

export interface DocoGitHubContext {
  handle: string;
  orgHandle: string;
  connection: GitHubConnection | null;
}

/**
 * One-query fetch of the Doco's handle, its org handle, and its GitHub
 * connection — the fields a backfill needs (docoSlug, ownerSlug, repo +
 * installation id).
 */
export async function getDocoGitHubContext(docoId: string): Promise<DocoGitHubContext | null> {
  return withClient(async (c) => {
    const r = await c.query<{ handle: string; org_handle: string; gh: GitHubConnection | null }>(
      `SELECT d.handle, o.handle AS org_handle, d.data->'github_integration' AS gh
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.id = $1`,
      [docoId],
    );
    const row = r.rows[0];
    return row
      ? { handle: row.handle, orgHandle: row.org_handle, connection: row.gh ?? null }
      : null;
  });
}
