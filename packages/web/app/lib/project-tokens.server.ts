/**
 * Committable, read-only project tokens for Docos. Stored at
 * .doco/project-tokens.json in repos that have minted one. Used by
 * agents that clone the repo to read the Doco without running OAuth.
 *
 * Distinct from OAuth access tokens (lib/oauth-server.server.ts):
 *   - Not tied to a user. The token represents the Doco
 *     itself; `created_by_user_id` is audit only.
 *   - Fixed scope: `reader` on exactly one Doco.
 *   - No expiry — committed-to-repo lifecycle; the only kill switch
 *     is the `revoked` flag, which an owner can flip from the
 *     project-tokens admin UI.
 *
 * Mint policy: owners-only, with the caller acknowledging that
 * anyone with read access to the repo will be able to read the
 * Doco. The acknowledgement is the API-level confirmation hook —
 * the UI surfaces a confirm dialog that maps to this flag.
 */
import { randomBytes } from "node:crypto";
import { withClient } from "@doco/db";

const PROJECT_TOKEN_PREFIX = "doco_pt_";

export interface ProjectToken {
  token: string;
  doco_id: string;
  created_by_user_id: string;
  label: string | null;
  revoked: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

/** Public summary used in the owner UI — no token body, just metadata. */
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
  // 32 bytes of entropy, base64url-encoded → 43 chars. Same shape as
  // oauth access tokens; the prefix keeps log scans unambiguous.
  return `${PROJECT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Token "id" exposed in the admin UI — last 8 chars of the body,
 * NOT the full token. The full token never leaves the server after
 * mint; this id is what owners reference when revoking.
 */
function tokenIdForSummary(token: string): string {
  return token.slice(-8);
}

function tokenPreview(token: string): string {
  return `${PROJECT_TOKEN_PREFIX}…${token.slice(-8)}`;
}

function summarize(row: ProjectToken): ProjectTokenSummary {
  return {
    id: tokenIdForSummary(row.token),
    preview: tokenPreview(row.token),
    label: row.label,
    revoked: row.revoked,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    created_by_user_id: row.created_by_user_id,
  };
}

export interface MintProjectTokenInput {
  doco_id: string;
  created_by_user_id: string;
  label?: string | null;
}

export interface MintProjectTokenResult {
  full_token: string;
  summary: ProjectTokenSummary;
}

/**
 * Mint a new project token. Caller must already have verified that
 * the actor is the Doco's owner and that they confirmed the "repo
 * readers can read this Doco" trade-off.
 */
export async function mintProjectToken(
  input: MintProjectTokenInput,
): Promise<MintProjectTokenResult> {
  const token = mintTokenString();
  const labelValue = (input.label ?? "").trim() || null;
  const row = await withClient(async (c) => {
    const r = await c.query<ProjectToken>(
      `INSERT INTO doco_project_tokens
         (token, doco_id, created_by_user_id, label)
       VALUES ($1, $2, $3, $4)
       RETURNING token, doco_id, created_by_user_id, label,
                 revoked, created_at, last_used_at`,
      [token, input.doco_id, input.created_by_user_id, labelValue],
    );
    return r.rows[0];
  });
  return { full_token: row.token, summary: summarize(row) };
}

/** List all (revoked + active) tokens for a Doco, newest first. */
export async function listProjectTokens(doco_id: string): Promise<ProjectTokenSummary[]> {
  return await withClient(async (c) => {
    const r = await c.query<ProjectToken>(
      `SELECT token, doco_id, created_by_user_id, label,
              revoked, created_at, last_used_at
         FROM doco_project_tokens
        WHERE doco_id = $1
        ORDER BY created_at DESC`,
      [doco_id],
    );
    return r.rows.map(summarize);
  });
}

/**
 * Revoke a token by its 8-char suffix id (the same id surfaced in
 * the admin UI). Scoped to a specific Doco so an owner of one Doco
 * can't accidentally revoke another Doco's token by guessing its
 * suffix.
 */
export async function revokeProjectTokenById(args: {
  doco_id: string;
  token_suffix_id: string;
}): Promise<boolean> {
  return await withClient(async (c) => {
    const r = await c.query<{ token: string }>(
      `UPDATE doco_project_tokens
          SET revoked = true
        WHERE doco_id = $1
          AND token LIKE $2
          AND revoked = false
        RETURNING token`,
      [args.doco_id, `%${args.token_suffix_id}`],
    );
    return r.rows.length > 0;
  });
}

/**
 * Lookup by full token body. Returns null when the token is unknown
 * or revoked. Touches `last_used_at` opportunistically (best-effort;
 * a failure here does not block the read).
 */
export async function validateProjectToken(token: string): Promise<ProjectToken | null> {
  if (!isProjectToken(token)) return null;
  const row = await withClient(async (c) => {
    const r = await c.query<ProjectToken>(
      `SELECT token, doco_id, created_by_user_id, label,
              revoked, created_at, last_used_at
         FROM doco_project_tokens
        WHERE token = $1 AND revoked = false`,
      [token],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return null;
  // Async touch — don't await; this is best-effort telemetry.
  void withClient((c) =>
    c.query("UPDATE doco_project_tokens SET last_used_at = now() WHERE token = $1", [token]),
  ).catch(() => {
    /* swallow: stale last_used_at is fine */
  });
  return row;
}
