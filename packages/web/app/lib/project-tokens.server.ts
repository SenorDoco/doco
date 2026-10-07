/**
 * Project tokens: a committable, read-only credential for one workspace.
 * Kept at .doco/project-tokens.json in a repository, so the Doco hook and
 * the agents that clone the repository read the workspace without OAuth.
 *
 * Distinct from OAuth access tokens (lib/oauth-server.server.ts):
 *   - Not tied to a user. The token stands for the repository that holds
 *     it; `created_by_user_id` is audit only.
 *   - Fixed scope: `reader` on every live Doco of one workspace.
 *   - No expiry; the `revoked` flag, flipped by a workspace owner, is the
 *     only kill switch.
 *
 * Owners mint one after acknowledging that anyone who can read the
 * repository will be able to read the whole workspace.
 */
import { randomBytes } from "node:crypto";
import { withClient } from "@doco/db";

const PROJECT_TOKEN_PREFIX = "doco_pt_";

export interface ProjectToken {
  token: string;
  workspace_id: string;
  created_by_user_id: string;
  label: string | null;
  revoked: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

/** What the owner's page shows: no token body, just metadata. */
export interface ProjectTokenSummary {
  id: string;
  preview: string;
  label: string | null;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
  created_by_user_id: string;
}

export function isProjectToken(value: string): boolean {
  return value.startsWith(PROJECT_TOKEN_PREFIX);
}

function mintTokenString(): string {
  // 32 bytes of entropy, base64url-encoded: 43 chars, the shape of an OAuth
  // access token; the prefix keeps log scans unambiguous.
  return `${PROJECT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The id the owner's page shows and revokes by: the last 8 characters. */
function tokenIdForSummary(token: string): string {
  return token.slice(-8);
}

function summarize(row: ProjectToken): ProjectTokenSummary {
  return {
    id: tokenIdForSummary(row.token),
    preview: `${PROJECT_TOKEN_PREFIX}…${tokenIdForSummary(row.token)}`,
    label: row.label,
    revoked: row.revoked,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    created_by_user_id: row.created_by_user_id,
  };
}

export interface MintProjectTokenInput {
  workspace_id: string;
  created_by_user_id: string;
  label?: string | null;
}

export interface MintProjectTokenResult {
  full_token: string;
  summary: ProjectTokenSummary;
}

/**
 * Mint a token. The caller has checked that the actor owns the workspace
 * and confirmed that the repository's readers may read it.
 */
export async function mintProjectToken(
  input: MintProjectTokenInput,
): Promise<MintProjectTokenResult> {
  const token = mintTokenString();
  const labelValue = (input.label ?? "").trim() || null;
  const row = await withClient(async (c) => {
    const r = await c.query<ProjectToken>(
      `INSERT INTO project_tokens (token, workspace_id, created_by_user_id, label)
       VALUES ($1, $2, $3, $4)
       RETURNING token, workspace_id, created_by_user_id, label, revoked, created_at, last_used_at`,
      [token, input.workspace_id, input.created_by_user_id, labelValue],
    );
    return r.rows[0];
  });
  return { full_token: row.token, summary: summarize(row) };
}

/** Every token of a workspace, revoked ones included, newest first. */
export async function listProjectTokens(workspace_id: string): Promise<ProjectTokenSummary[]> {
  return await withClient(async (c) => {
    const r = await c.query<ProjectToken>(
      `SELECT token, workspace_id, created_by_user_id, label, revoked, created_at, last_used_at
         FROM project_tokens WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspace_id],
    );
    return r.rows.map(summarize);
  });
}

/**
 * Revoke a token by the 8-character id the owner's page shows, within one
 * workspace, so an owner cannot revoke another workspace's token by guessing
 * its suffix. False when nothing was revoked.
 */
export async function revokeProjectTokenById(args: {
  workspace_id: string;
  token_suffix_id: string;
}): Promise<boolean> {
  return await withClient(async (c) => {
    const r = await c.query<{ token: string }>(
      `UPDATE project_tokens SET revoked = true
        WHERE workspace_id = $1 AND token LIKE $2 AND revoked = false
        RETURNING token`,
      [args.workspace_id, `%${args.token_suffix_id}`],
    );
    return r.rows.length > 0;
  });
}

/**
 * The token behind a bearer, or null when it is not a project token, is
 * unknown or is revoked. Touches `last_used_at` without waiting.
 */
export async function validateProjectToken(token: string): Promise<ProjectToken | null> {
  if (!isProjectToken(token)) return null;
  const row = await withClient(async (c) => {
    const r = await c.query<ProjectToken>(
      `SELECT token, workspace_id, created_by_user_id, label, revoked, created_at, last_used_at
         FROM project_tokens WHERE token = $1 AND revoked = false`,
      [token],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return null;
  void withClient((c) =>
    c.query("UPDATE project_tokens SET last_used_at = now() WHERE token = $1", [token]),
  ).catch(() => {
    /* a stale last_used_at is fine */
  });
  return row;
}

export interface ProjectTokenDoco {
  id: string;
  handle: string;
  goal: string;
  owner_id: string;
}

/** The Docos a token reads: every live Doco of its workspace. */
export async function queryProjectTokenDocos(
  c: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
  workspace_id: string,
): Promise<ProjectTokenDoco[]> {
  const r = await c.query<ProjectTokenDoco>(
    `SELECT id, handle, goal, owner_id FROM docos
      WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY handle`,
    [workspace_id],
  );
  return r.rows;
}

/**
 * What the agent does with a fresh token, shown once with it wherever one is
 * minted (the workspace's setup, its project tokens page, the API): save it
 * where the Doco hook reads it, keep it out of a public repository's history,
 * and install the hook if it isn't yet.
 */
export function projectTokenInstallHint(
  baseUrl: string,
  workspaceHandle: string,
  fullToken: string,
): string {
  const host = baseUrl.replace(/\/+$/, "");
  return [
    `Turn on the Doco hook in this project for the workspace ${workspaceHandle} with this project token, which reads every Doco in ${workspaceHandle}.`,
    "",
    "Save it in `.doco/project-tokens.json` at the root of the repository, keeping any entries already there:",
    "",
    "```json",
    "{",
    `  "${workspaceHandle}": "${fullToken}"`,
    "}",
    "```",
    "",
    "Commit the file so every clone of the repository has the token, unless the repository is public: then add `.doco/project-tokens.json` to `.gitignore` instead.",
    "",
    `If the Doco hook isn't installed yet, install it as ${host}/agents#hook shows. Then tell the user the hook is on: it briefs you from ${workspaceHandle} before each prompt and each file edit.`,
  ].join("\n");
}
