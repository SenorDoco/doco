/**
 * Hook tokens: a read-only credential that reads one workspace as the
 * person who made it (decision_01M4C2J610DPD028P55Q8X6VG2). The Doco hook
 * reads it from .doco/hook-tokens.json, kept out of git, or DOCO_TOKEN.
 * They were project tokens (doco_pt_…) until schema.sql renamed them.
 *
 * Distinct from OAuth access tokens (lib/oauth-server.server.ts):
 *   - It reads, and only reads, what its maker can read in its workspace,
 *     checked on every request (lib/doco-access.server.ts), so it loses
 *     what they lose.
 *   - No expiry; the `revoked` flag is the only kill switch, flipped by its
 *     maker or a workspace owner.
 *
 * Any member makes their own on the workspace's hook tokens page or its
 * API; an agent gets its person's token for the Doco hook from the MCP tool
 * doco_hook_token (hookTokenFor), the same one every time.
 */
import { randomBytes } from "node:crypto";
import { withClient } from "@doco/db";

const HOOK_TOKEN_PREFIX = "doco_ht_";

export interface HookToken {
  token: string;
  workspace_id: string;
  created_by_user_id: string;
  label: string | null;
  revoked: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

/** What the hook tokens page shows: no token body, just metadata. */
export interface HookTokenSummary {
  id: string;
  preview: string;
  label: string | null;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
  created_by_user_id: string;
  /** The maker's GitHub login. */
  created_by: string | null;
}

/** The label of the token doco_hook_token makes, which hookTokenFor finds. */
const HOOK_TOKEN_LABEL = "Doco hook";

export function isHookToken(value: string): boolean {
  return value.startsWith(HOOK_TOKEN_PREFIX);
}

function mintTokenString(): string {
  // 32 bytes of entropy, base64url-encoded: 43 chars, the shape of an OAuth
  // access token; the prefix keeps log scans unambiguous.
  return `${HOOK_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The id the hook tokens page shows and revokes by: the last 8 characters. */
function tokenIdForSummary(token: string): string {
  return token.slice(-8);
}

const SUMMARY_SQL = `
  SELECT ht.token, ht.workspace_id, ht.created_by_user_id, ht.label, ht.revoked,
         ht.created_at, ht.last_used_at, u.github_login AS created_by
    FROM hook_tokens ht
    LEFT JOIN users u ON u.id = ht.created_by_user_id`;

function summarize(row: HookToken & { created_by: string | null }): HookTokenSummary {
  return {
    id: tokenIdForSummary(row.token),
    preview: `${HOOK_TOKEN_PREFIX}…${tokenIdForSummary(row.token)}`,
    label: row.label,
    revoked: row.revoked,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    created_by_user_id: row.created_by_user_id,
    created_by: row.created_by,
  };
}

export interface MintHookTokenInput {
  workspace_id: string;
  created_by_user_id: string;
  label?: string | null;
}

export interface MintHookTokenResult {
  full_token: string;
  summary: HookTokenSummary;
}

/** Mint a token. The caller has checked that its maker is a member of the workspace. */
export async function mintHookToken(input: MintHookTokenInput): Promise<MintHookTokenResult> {
  const token = mintTokenString();
  const labelValue = (input.label ?? "").trim() || null;
  const row = await withClient(async (c) => {
    await c.query(
      `INSERT INTO hook_tokens (token, workspace_id, created_by_user_id, label)
       VALUES ($1, $2, $3, $4)`,
      [token, input.workspace_id, input.created_by_user_id, labelValue],
    );
    const r = await c.query<HookToken & { created_by: string | null }>(
      `${SUMMARY_SQL} WHERE ht.token = $1`,
      [token],
    );
    return r.rows[0];
  });
  return { full_token: row.token, summary: summarize(row) };
}

/**
 * A person's token for the Doco hook in a workspace: the one they have, or a
 * new one the first time. The caller has checked that they are a member.
 */
export async function hookTokenFor(input: {
  workspace_id: string;
  user_id: string;
}): Promise<string> {
  const existing = await withClient((c) =>
    c.query<{ token: string }>(
      `SELECT token FROM hook_tokens
        WHERE workspace_id = $1 AND created_by_user_id = $2 AND label = $3 AND NOT revoked
        ORDER BY created_at
        LIMIT 1`,
      [input.workspace_id, input.user_id, HOOK_TOKEN_LABEL],
    ),
  );
  if (existing.rows[0]) return existing.rows[0].token;
  const { full_token } = await mintHookToken({
    workspace_id: input.workspace_id,
    created_by_user_id: input.user_id,
    label: HOOK_TOKEN_LABEL,
  });
  return full_token;
}

/**
 * A workspace's tokens, revoked ones included, newest first: everyone's for
 * an owner (`madeBy` null), or the ones a member made.
 */
export async function listHookTokens(
  workspace_id: string,
  madeBy: string | null,
): Promise<HookTokenSummary[]> {
  return await withClient(async (c) => {
    const r = await c.query<HookToken & { created_by: string | null }>(
      `${SUMMARY_SQL}
        WHERE ht.workspace_id = $1 AND ($2::text IS NULL OR ht.created_by_user_id = $2)
        ORDER BY ht.created_at DESC`,
      [workspace_id, madeBy],
    );
    return r.rows.map(summarize);
  });
}

/**
 * Revoke a token by the 8-character id the hook tokens page shows, within
 * one workspace, so nobody revokes another workspace's token by guessing its
 * suffix: any of them for an owner (`created_by_user_id` null), or one a
 * member made. False when nothing was revoked.
 */
export async function revokeHookTokenById(args: {
  workspace_id: string;
  token_suffix_id: string;
  created_by_user_id: string | null;
}): Promise<boolean> {
  return await withClient(async (c) => {
    const r = await c.query<{ token: string }>(
      `UPDATE hook_tokens SET revoked = true
        WHERE workspace_id = $1 AND token LIKE $2 AND revoked = false
          AND ($3::text IS NULL OR created_by_user_id = $3)
        RETURNING token`,
      [args.workspace_id, `%${args.token_suffix_id}`, args.created_by_user_id],
    );
    return r.rows.length > 0;
  });
}

/**
 * The token behind a bearer, or null when it is not a hook token, is
 * unknown or is revoked. Touches `last_used_at` without waiting.
 */
export async function validateHookToken(token: string): Promise<HookToken | null> {
  if (!isHookToken(token)) return null;
  const row = await withClient(async (c) => {
    const r = await c.query<HookToken>(
      `SELECT token, workspace_id, created_by_user_id, label, revoked, created_at, last_used_at
         FROM hook_tokens WHERE token = $1 AND revoked = false`,
      [token],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return null;
  void withClient((c) =>
    c.query("UPDATE hook_tokens SET last_used_at = now() WHERE token = $1", [token]),
  ).catch(() => {
    /* a stale last_used_at is fine */
  });
  return row;
}

/**
 * What the agent does with a token, handed over with it (doco_hook_token, the
 * hook tokens page, the API): save it where the Doco hook reads it, keep
 * it out of git since it reads as its maker, and install the hook if it isn't
 * yet.
 */
export function hookTokenInstallHint(
  baseUrl: string,
  workspaceHandle: string,
  fullToken: string,
): string {
  const host = baseUrl.replace(/\/+$/, "");
  return [
    `Turn on the Doco hook in this project for the workspace ${workspaceHandle} with this token. It reads what the user can read in ${workspaceHandle}, as them, so it stays out of git.`,
    "",
    "Save it in `.doco/hook-tokens.json` at the root of the repository, keeping any entries already there, and add `.doco/hook-tokens.json` to `.gitignore`:",
    "",
    "```json",
    "{",
    `  "${workspaceHandle}": "${fullToken}"`,
    "}",
    "```",
    "",
    `If the Doco hook isn't installed yet, install it as ${host}/agents#hook shows. Then tell the user the hook is on: it briefs you from ${workspaceHandle} before each prompt and each file edit.`,
  ].join("\n");
}
