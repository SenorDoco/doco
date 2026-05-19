// OAuth 2.1 authorization server — the doco.to side of MCP-OAuth
// (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).
//
// Replaces the legacy DOCO_ACCESS bearer in `./.env`. Agents no
// longer hold credentials directly: an MCP runtime registers itself
// (RFC 7591), opens the authorize URL in the user's browser, the
// user signs in with GitHub + approves which Docos this runtime can
// touch, the runtime exchanges the resulting code for an access +
// refresh token, and attaches `Authorization: Bearer <token>` on
// every subsequent /mcp + /<handle>/api/* request.
//
// What lives here:
//   - Client registration (dynamic, RFC 7591).
//   - Authorization-code mint + consume (with PKCE S256).
//   - Access + refresh token issuance.
//   - Bearer-token validation (called from every authenticated route).
//   - Refresh-token rotation.
//   - Token revocation (RFC 7009).
//
// What does NOT live here: the HTTP routes themselves (those compose
// these functions), or the authorize-page UI. Both sit in
// `app/routes/oauth.*.tsx` and pass through the helpers below.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withClient, withTransaction } from "@doco/db";

// ---------------------------------------------------------------------------
// Token formats & TTLs.
// ---------------------------------------------------------------------------

// Prefixed opaque tokens. The prefix is purely for human debuggability
// (`doco_at_…` vs `doco_rt_…` in logs); validation matches the entire
// string against the row's `token` column.
const CODE_PREFIX = "doco_code_";
const ACCESS_TOKEN_PREFIX = "doco_at_";
const REFRESH_TOKEN_PREFIX = "doco_rt_";
const CLIENT_ID_PREFIX = "doco_client_";

const AUTH_CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const REFRESH_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60; // 60d

// 32 random bytes → 43-char base64url. That's 256 bits of entropy —
// over the OAuth 2.1 recommended floor of 128 bits.
function mintOpaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function isOauthAccessToken(value: string): boolean {
  return value.startsWith(ACCESS_TOKEN_PREFIX);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636).
// ---------------------------------------------------------------------------

/** Verify a base64url(SHA-256(verifier)) matches the stored challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest();
  const expected = Buffer.from(challenge, "base64url");
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

// ---------------------------------------------------------------------------
// Client registration (RFC 7591).
// ---------------------------------------------------------------------------

export interface RegisterClientInput {
  client_name?: string;
  redirect_uris: string[];
  software_id?: string;
  software_version?: string;
}

export interface OauthClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  software_id: string | null;
  software_version: string | null;
  registered_at: Date;
}

export async function registerClient(input: RegisterClientInput): Promise<OauthClientRow> {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new OauthError("invalid_redirect_uri", "redirect_uris must contain at least one entry");
  }
  for (const uri of input.redirect_uris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      throw new OauthError("invalid_redirect_uri", `not a valid redirect_uri: ${uri}`);
    }
  }
  const client_id = mintOpaque(CLIENT_ID_PREFIX);
  return await withClient(async (c) => {
    const r = await c.query<OauthClientRow>(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, software_id, software_version)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING client_id, client_name, redirect_uris, grant_types, response_types,
                 token_endpoint_auth_method, software_id, software_version, registered_at`,
      [
        client_id,
        input.client_name ?? null,
        input.redirect_uris,
        input.software_id ?? null,
        input.software_version ?? null,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new OauthError("server_error", "client registration returned no row");
    return row;
  });
}

export async function getClient(client_id: string): Promise<OauthClientRow | null> {
  if (!client_id.startsWith(CLIENT_ID_PREFIX)) return null;
  return await withClient(async (c) => {
    const r = await c.query<OauthClientRow>(
      `SELECT client_id, client_name, redirect_uris, grant_types, response_types,
              token_endpoint_auth_method, software_id, software_version, registered_at
         FROM oauth_clients WHERE client_id = $1`,
      [client_id],
    );
    return r.rows[0] ?? null;
  });
}

/**
 * Redirect URIs are restricted to http/https, loopback IPs for native
 * apps (RFC 8252), and `urn:ietf:wg:oauth:2.0:oob` for the rare
 * out-of-band copy/paste case. Custom-scheme URIs (e.g. `myapp://`)
 * are also accepted per RFC 8252 §7.1.
 */
function isValidRedirectUri(uri: string): boolean {
  if (uri === "urn:ietf:wg:oauth:2.0:oob") return true;
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" || u.protocol === "https:") return true;
    // Custom schemes like `cursor://` `claude-code://` — RFC 8252 §7.1.
    if (/^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Authorization codes.
// ---------------------------------------------------------------------------

export interface IssueAuthCodeInput {
  client_id: string;
  principal_id: string;
  redirect_uri: string;
  code_challenge: string;
  granted_doco_ids: string[];
  scope?: string;
}

export async function issueAuthorizationCode(input: IssueAuthCodeInput): Promise<{ code: string; expires_at: Date }> {
  const code = mintOpaque(CODE_PREFIX);
  const expires_at = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO oauth_authorization_codes
         (code, client_id, principal_id, redirect_uri,
          code_challenge, code_challenge_method, granted_doco_ids, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'S256', $6, $7, $8)`,
      [
        code,
        input.client_id,
        input.principal_id,
        input.redirect_uri,
        input.code_challenge,
        input.granted_doco_ids,
        input.scope ?? null,
        expires_at,
      ],
    );
  });
  return { code, expires_at };
}

export interface ConsumedAuthCode {
  principal_id: string;
  granted_doco_ids: string[];
  scope: string | null;
}

/**
 * Single-use, atomic: claim the code (mark `consumed_at`), validate
 * client + redirect + PKCE, return the carried principal + grants.
 * Throws an OauthError if any check fails.
 */
export async function consumeAuthorizationCode(args: {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
}): Promise<ConsumedAuthCode> {
  return await withTransaction(async (c) => {
    const r = await c.query<{
      client_id: string;
      principal_id: string;
      redirect_uri: string;
      code_challenge: string;
      granted_doco_ids: string[];
      scope: string | null;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT client_id, principal_id, redirect_uri, code_challenge,
              granted_doco_ids, scope, expires_at, consumed_at
         FROM oauth_authorization_codes
        WHERE code = $1
        FOR UPDATE`,
      [args.code],
    );
    const row = r.rows[0];
    if (!row) throw new OauthError("invalid_grant", "authorization code not found");
    if (row.consumed_at) throw new OauthError("invalid_grant", "authorization code already used");
    if (row.expires_at.getTime() < Date.now()) {
      throw new OauthError("invalid_grant", "authorization code expired");
    }
    if (row.client_id !== args.client_id) {
      throw new OauthError("invalid_grant", "client_id mismatch on authorization code");
    }
    if (row.redirect_uri !== args.redirect_uri) {
      throw new OauthError("invalid_grant", "redirect_uri mismatch on authorization code");
    }
    if (!verifyPkce(args.code_verifier, row.code_challenge)) {
      throw new OauthError("invalid_grant", "code_verifier does not match code_challenge");
    }
    await c.query(
      `UPDATE oauth_authorization_codes SET consumed_at = now() WHERE code = $1`,
      [args.code],
    );
    return {
      principal_id: row.principal_id,
      granted_doco_ids: row.granted_doco_ids,
      scope: row.scope,
    };
  });
}

// ---------------------------------------------------------------------------
// Access + refresh tokens.
// ---------------------------------------------------------------------------

export interface IssueTokensInput {
  client_id: string;
  principal_id: string;
  granted_doco_ids: string[];
  scope: string | null;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string | null;
}

export async function issueTokens(input: IssueTokensInput): Promise<IssuedTokens> {
  const access_token = mintOpaque(ACCESS_TOKEN_PREFIX);
  const refresh_token = mintOpaque(REFRESH_TOKEN_PREFIX);
  const access_expires = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refresh_expires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO oauth_access_tokens
         (token, client_id, principal_id, granted_doco_ids, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        access_token,
        input.client_id,
        input.principal_id,
        input.granted_doco_ids,
        input.scope,
        access_expires,
      ],
    );
    await c.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, principal_id, granted_doco_ids, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        refresh_token,
        input.client_id,
        input.principal_id,
        input.granted_doco_ids,
        input.scope,
        refresh_expires,
      ],
    );
  });
  return {
    access_token,
    refresh_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: input.scope,
  };
}

export interface ValidAccessToken {
  token: string;
  client_id: string;
  principal_id: string;
  granted_doco_ids: string[];
  scope: string | null;
  expires_at: Date;
}

/**
 * O(1) validation: exact string match against the access-token table,
 * plus the unrevoked + unexpired predicates. Called on every
 * authenticated request — keep it cheap.
 */
export async function validateAccessToken(token: string): Promise<ValidAccessToken | null> {
  if (!isOauthAccessToken(token)) return null;
  return await withClient(async (c) => {
    const r = await c.query<ValidAccessToken>(
      `SELECT token, client_id, principal_id, granted_doco_ids, scope, expires_at
         FROM oauth_access_tokens
        WHERE token = $1 AND revoked = false AND expires_at > now()`,
      [token],
    );
    return r.rows[0] ?? null;
  });
}

export async function refreshTokens(args: {
  client_id: string;
  refresh_token: string;
}): Promise<IssuedTokens> {
  return await withTransaction(async (c) => {
    const r = await c.query<{
      client_id: string;
      principal_id: string;
      granted_doco_ids: string[];
      scope: string | null;
      expires_at: Date;
      revoked: boolean;
    }>(
      `SELECT client_id, principal_id, granted_doco_ids, scope, expires_at, revoked
         FROM oauth_refresh_tokens
        WHERE token = $1
        FOR UPDATE`,
      [args.refresh_token],
    );
    const row = r.rows[0];
    if (!row) throw new OauthError("invalid_grant", "refresh token not found");
    if (row.revoked) throw new OauthError("invalid_grant", "refresh token revoked");
    if (row.expires_at.getTime() < Date.now()) {
      throw new OauthError("invalid_grant", "refresh token expired");
    }
    if (row.client_id !== args.client_id) {
      throw new OauthError("invalid_grant", "client_id mismatch on refresh token");
    }
    // Rotation: mark the old refresh token revoked, mint a fresh pair.
    const access_token = mintOpaque(ACCESS_TOKEN_PREFIX);
    const refresh_token = mintOpaque(REFRESH_TOKEN_PREFIX);
    const access_expires = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refresh_expires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    await c.query(
      `INSERT INTO oauth_access_tokens
         (token, client_id, principal_id, granted_doco_ids, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [access_token, row.client_id, row.principal_id, row.granted_doco_ids, row.scope, access_expires],
    );
    await c.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, principal_id, granted_doco_ids, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [refresh_token, row.client_id, row.principal_id, row.granted_doco_ids, row.scope, refresh_expires],
    );
    await c.query(
      `UPDATE oauth_refresh_tokens SET revoked = true, superseded_by = $1 WHERE token = $2`,
      [refresh_token, args.refresh_token],
    );
    return {
      access_token,
      refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: row.scope,
    };
  });
}

/**
 * RFC 7009 token revocation. Idempotent — revoking a non-existent or
 * already-revoked token is a no-op (200 OK either way, per spec).
 * The `token_type_hint` is advisory; we try both tables.
 */
export async function revokeToken(token: string, _hint?: "access_token" | "refresh_token"): Promise<void> {
  await withClient(async (c) => {
    await c.query(`UPDATE oauth_access_tokens  SET revoked = true WHERE token = $1`, [token]);
    await c.query(`UPDATE oauth_refresh_tokens SET revoked = true WHERE token = $1`, [token]);
  });
}

// ---------------------------------------------------------------------------
// OAuth error envelope (RFC 6749 §5.2).
// ---------------------------------------------------------------------------

export type OauthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_redirect_uri"
  | "server_error";

export class OauthError extends Error {
  readonly code: OauthErrorCode;
  constructor(code: OauthErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "OauthError";
  }
}
