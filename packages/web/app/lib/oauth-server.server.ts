// OAuth 2.1 authorization server — the doco.to side of MCP-OAuth
// (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).
//
// OAuth-backed DOCO_ACCESS tokens for programmatic clients. An MCP runtime registers
// itself (RFC 7591), opens the authorize URL in the user's browser, the
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
//   - Refresh-token exchange (non-rotating: reissues the access token,
//     keeps the same refresh token).
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
// 24h. Safe to keep long: opaque tokens are DB-checked on every request
// (revoked = false AND expires_at > now()) and revocable via /oauth/revoke,
// so there's no JWT-style revocation-lag window from a longer lifetime.
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60; // 60d
const DOCO_ROLES = ["reader", "writer", "owner"] as const;

// 32 random bytes → 43-char base64url. That's 256 bits of entropy —
// over the OAuth 2.1 recommended floor of 128 bits.
function mintOpaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function isOauthAccessToken(value: string): boolean {
  return value.startsWith(ACCESS_TOKEN_PREFIX);
}

export function normalizeTokenName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) {
    throw new OauthError("invalid_request", "token_name required");
  }
  if (name.length > 120) {
    throw new OauthError("invalid_request", "token_name must be 120 characters or less");
  }
  return name;
}

function isDocoRole(value: string | undefined): value is (typeof DOCO_ROLES)[number] {
  return value !== undefined && (DOCO_ROLES as readonly string[]).includes(value);
}

function roleForGrant(grants: Record<string, string> | undefined, id: string): string {
  const role = grants?.[id];
  return isDocoRole(role) ? role : "owner";
}

// ---------------------------------------------------------------------------
// Grant sets & additive merge.
// ---------------------------------------------------------------------------

/** The set of Docos + orgs (with per-target role scope-down) an
 * authorization grants. Shared shape across auth codes, device rows, and
 * the tokens they mint. */
export interface GrantSets {
  granted_doco_ids: string[];
  granted_doco_roles: Record<string, string>;
  granted_doco_write_types: Record<string, string[]>;
  granted_org_ids: string[];
  granted_org_roles: Record<string, string>;
  granted_org_write_types: Record<string, string[]>;
}

/** Power ordering of the three roles; the higher one wins when merging
 * two grants on the same target. Mirrors `rankOf` in user-invite, inlined
 * here to keep this server module free of `~/` path aliases (which the
 * unit-test runner doesn't resolve). */
function roleRank(role: string): number {
  return role === "owner" ? 2 : role === "writer" ? 1 : 0;
}

function mergeScope(
  baseIds: string[],
  baseRoles: Record<string, string>,
  incomingIds: string[],
  incomingRoles: Record<string, string>,
): { ids: string[]; roles: Record<string, string> } {
  const baseSet = new Set(baseIds);
  const incomingSet = new Set(incomingIds);
  const roles: Record<string, string> = {};
  const ids: string[] = [];
  for (const id of new Set([...baseIds, ...incomingIds])) {
    ids.push(id);
    const candidates: string[] = [];
    if (baseSet.has(id)) candidates.push(roleForGrant(baseRoles, id));
    if (incomingSet.has(id)) candidates.push(roleForGrant(incomingRoles, id));
    // Keep the strongest role present — re-authorization widens, it never
    // silently narrows an existing grant.
    roles[id] = candidates.reduce((a, b) => (roleRank(b) > roleRank(a) ? b : a));
  }
  ids.sort();
  return { ids, roles };
}

function mergeWriteTypeScope(
  ids: string[],
  baseIds: string[],
  baseWriteTypes: Record<string, string[]>,
  incomingIds: string[],
  incomingWriteTypes: Record<string, string[]>,
): Record<string, string[]> {
  const baseSet = new Set(baseIds);
  const incomingSet = new Set(incomingIds);
  const merged: Record<string, string[]> = {};

  for (const id of ids) {
    const baseHasGrant = baseSet.has(id);
    const incomingHasGrant = incomingSet.has(id);
    const baseTypes = baseWriteTypes[id];
    const incomingTypes = incomingWriteTypes[id];

    if ((baseHasGrant && !baseTypes) || (incomingHasGrant && !incomingTypes)) {
      continue;
    }

    const types = new Set<string>();
    if (baseTypes) for (const type of baseTypes) types.add(type);
    if (incomingTypes) for (const type of incomingTypes) types.add(type);
    if (types.size > 0) merged[id] = Array.from(types).sort();
  }

  return merged;
}

/**
 * Union two grant sets for additive re-authorization. The merged set
 * covers every Doco/org in EITHER input; for an id in both it keeps the
 * STRONGER role. Re-authorizing a token therefore only ever widens its
 * access (more targets, or a higher role) — it never silently revokes a
 * grant the incoming approval happened to omit. Removing access is the
 * owner's explicit action on the token's grants, not a side effect of
 * re-approval. Roles remain bounded by what the approver holds — that
 * cap is enforced by the caller before this runs.
 */
export function mergeGrantSets(base: GrantSets, incoming: GrantSets): GrantSets {
  const doco = mergeScope(
    base.granted_doco_ids,
    base.granted_doco_roles,
    incoming.granted_doco_ids,
    incoming.granted_doco_roles,
  );
  const org = mergeScope(
    base.granted_org_ids,
    base.granted_org_roles,
    incoming.granted_org_ids,
    incoming.granted_org_roles,
  );
  return {
    granted_doco_ids: doco.ids,
    granted_doco_roles: doco.roles,
    granted_doco_write_types: mergeWriteTypeScope(
      doco.ids,
      base.granted_doco_ids,
      base.granted_doco_write_types,
      incoming.granted_doco_ids,
      incoming.granted_doco_write_types,
    ),
    granted_org_ids: org.ids,
    granted_org_roles: org.roles,
    granted_org_write_types: mergeWriteTypeScope(
      org.ids,
      base.granted_org_ids,
      base.granted_org_write_types,
      incoming.granted_org_ids,
      incoming.granted_org_write_types,
    ),
  };
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
  approver_user_id: string;
  token_name: string;
  redirect_uri: string;
  code_challenge: string;
  granted_doco_ids: string[];
  /**
   * Per-Doco role scope-down. Map of doco_id → DocoRole. The user
   * approving the OAuth grant can lower the role below what they
   * themselves hold (give the token "reader" on a Doco where they
   * are "owner") but never raise it. Missing entries on this map
   * mean "inherit the principal's actual role on that Doco" —
   * i.e. no scope-down for that Doco.
   */
  granted_doco_roles?: Record<string, string>;
  /** Per-type write scope-down keyed by doco_id. Missing entry means all write types. */
  granted_doco_write_types?: Record<string, string[]>;
  /**
   * Org-level grants. Listed org ids extend access to every Doco
   * the org owns (live — including Docos created under the org
   * after the token is minted). `granted_org_roles[org_id]` caps
   * the effective role on Docos under that org.
   */
  granted_org_ids?: string[];
  granted_org_roles?: Record<string, string>;
  /** Per-type write scope-down keyed by org_id. Missing entry means all write types. */
  granted_org_write_types?: Record<string, string[]>;
  scope?: string;
}

export async function issueAuthorizationCode(
  input: IssueAuthCodeInput,
): Promise<{ code: string; expires_at: Date }> {
  const code = mintOpaque(CODE_PREFIX);
  const expires_at = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);
  const tokenName = normalizeTokenName(input.token_name);
  const grants: GrantSets = {
    granted_doco_ids: input.granted_doco_ids,
    granted_doco_roles: input.granted_doco_roles ?? {},
    granted_doco_write_types: input.granted_doco_write_types ?? {},
    granted_org_ids: input.granted_org_ids ?? [],
    granted_org_roles: input.granted_org_roles ?? {},
    granted_org_write_types: input.granted_org_write_types ?? {},
  };
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO oauth_authorization_codes
         (code, client_id, user_id, redirect_uri, token_name,
          code_challenge, code_challenge_method, granted_doco_ids,
          granted_doco_roles, granted_doco_write_types,
          granted_org_ids, granted_org_roles, granted_org_write_types,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'S256', $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        code,
        input.client_id,
        input.approver_user_id,
        input.redirect_uri,
        tokenName,
        input.code_challenge,
        grants.granted_doco_ids,
        JSON.stringify(grants.granted_doco_roles),
        JSON.stringify(grants.granted_doco_write_types),
        grants.granted_org_ids,
        JSON.stringify(grants.granted_org_roles),
        JSON.stringify(grants.granted_org_write_types),
        input.scope ?? null,
        expires_at,
      ],
    );
  });
  return { code, expires_at };
}

export interface ConsumedAuthCode {
  user_id: string;
  token_name: string | null;
  granted_doco_ids: string[];
  granted_doco_roles: Record<string, string>;
  granted_doco_write_types: Record<string, string[]>;
  granted_org_ids: string[];
  granted_org_roles: Record<string, string>;
  granted_org_write_types: Record<string, string[]>;
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
      user_id: string;
      token_name: string | null;
      redirect_uri: string;
      code_challenge: string;
      granted_doco_ids: string[];
      granted_doco_roles: Record<string, string>;
      granted_doco_write_types: Record<string, string[]>;
      granted_org_ids: string[];
      granted_org_roles: Record<string, string>;
      granted_org_write_types: Record<string, string[]>;
      scope: string | null;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT client_id, user_id, token_name, redirect_uri, code_challenge,
              granted_doco_ids, granted_doco_roles, granted_doco_write_types,
              granted_org_ids, granted_org_roles, granted_org_write_types,
              scope, expires_at, consumed_at
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
    await c.query("UPDATE oauth_authorization_codes SET consumed_at = now() WHERE code = $1", [
      args.code,
    ]);
    return {
      user_id: row.user_id,
      token_name: row.token_name,
      granted_doco_ids: row.granted_doco_ids,
      granted_doco_roles: row.granted_doco_roles ?? {},
      granted_doco_write_types: row.granted_doco_write_types ?? {},
      granted_org_ids: row.granted_org_ids ?? [],
      granted_org_roles: row.granted_org_roles ?? {},
      granted_org_write_types: row.granted_org_write_types ?? {},
      scope: row.scope,
    };
  });
}

export interface PeekedAuthCode {
  client_id: string;
  redirect_uri: string;
  granted_doco_ids: string[];
  granted_org_ids: string[];
}

/**
 * Read an authorization code row WITHOUT consuming it. Returns null
 * if the code is unknown, already consumed, or expired. Used by the
 * `/oauth/approved` interstitial to validate that the user-supplied
 * `?to=` redirect target actually corresponds to a real, pending
 * auth code — so the route can't be abused as an open redirect.
 *
 * Never use this for the token exchange — that path must be atomic
 * (claim + validate in one transaction). Use `consumeAuthorizationCode`.
 */
export async function peekAuthorizationCode(code: string): Promise<PeekedAuthCode | null> {
  return await withClient(async (c) => {
    const r = await c.query<{
      client_id: string;
      redirect_uri: string;
      granted_doco_ids: string[];
      granted_org_ids: string[] | null;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT client_id, redirect_uri, granted_doco_ids,
              granted_org_ids, expires_at, consumed_at
         FROM oauth_authorization_codes
        WHERE code = $1`,
      [code],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.consumed_at) return null;
    if (row.expires_at.getTime() < Date.now()) return null;
    return {
      client_id: row.client_id,
      redirect_uri: row.redirect_uri,
      granted_doco_ids: row.granted_doco_ids,
      granted_org_ids: row.granted_org_ids ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// Access + refresh tokens.
// ---------------------------------------------------------------------------

export interface IssueTokensInput {
  client_id: string;
  user_id: string;
  token_name?: string | null;
  granted_doco_ids: string[];
  granted_doco_roles?: Record<string, string>;
  /** Per-type write scope-down keyed by doco_id (decision_per_type_write_grants). */
  granted_doco_write_types?: Record<string, string[]>;
  granted_org_ids?: string[];
  granted_org_roles?: Record<string, string>;
  /** Per-type write scope-down keyed by org_id. */
  granted_org_write_types?: Record<string, string[]>;
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
  const rolesJson = JSON.stringify(input.granted_doco_roles ?? {});
  const docoWriteTypesJson = JSON.stringify(input.granted_doco_write_types ?? {});
  const orgIds = input.granted_org_ids ?? [];
  const orgRolesJson = JSON.stringify(input.granted_org_roles ?? {});
  const orgWriteTypesJson = JSON.stringify(input.granted_org_write_types ?? {});
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO oauth_access_tokens
         (token, client_id, user_id, token_name, granted_doco_ids,
          granted_doco_roles, granted_doco_write_types,
          granted_org_ids, granted_org_roles, granted_org_write_types,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        access_token,
        input.client_id,
        input.user_id,
        input.token_name ?? null,
        input.granted_doco_ids,
        rolesJson,
        docoWriteTypesJson,
        orgIds,
        orgRolesJson,
        orgWriteTypesJson,
        input.scope,
        access_expires,
      ],
    );
    await c.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, user_id, token_name, granted_doco_ids,
          granted_doco_roles, granted_doco_write_types,
          granted_org_ids, granted_org_roles, granted_org_write_types,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        refresh_token,
        input.client_id,
        input.user_id,
        input.token_name ?? null,
        input.granted_doco_ids,
        rolesJson,
        docoWriteTypesJson,
        orgIds,
        orgRolesJson,
        orgWriteTypesJson,
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
  client_name: string | null;
  user_id: string;
  token_name: string | null;
  granted_doco_ids: string[];
  granted_doco_roles: Record<string, string>;
  /** Per-type write scope-down keyed by doco_id. */
  granted_doco_write_types: Record<string, string[]>;
  granted_org_ids: string[];
  granted_org_roles: Record<string, string>;
  /** Per-type write scope-down keyed by org_id. */
  granted_org_write_types: Record<string, string[]>;
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
      `SELECT at.token, at.client_id, c.client_name, at.user_id, at.token_name,
              at.granted_doco_ids,
              at.granted_doco_roles, at.granted_doco_write_types,
              at.granted_org_ids, at.granted_org_roles, at.granted_org_write_types,
              at.scope, at.expires_at
         FROM oauth_access_tokens at
         JOIN oauth_clients c ON c.client_id = at.client_id
        WHERE at.token = $1 AND at.revoked = false AND at.expires_at > now()`,
      [token],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      ...row,
      granted_doco_roles: row.granted_doco_roles ?? {},
      granted_doco_write_types: row.granted_doco_write_types ?? {},
      granted_org_ids: row.granted_org_ids ?? [],
      granted_org_roles: row.granted_org_roles ?? {},
      granted_org_write_types: row.granted_org_write_types ?? {},
    };
  });
}

export async function refreshTokens(args: {
  client_id: string;
  refresh_token: string;
}): Promise<IssuedTokens> {
  return await withTransaction(async (c) => {
    const r = await c.query<{
      client_id: string;
      user_id: string;
      token_name: string | null;
      granted_doco_ids: string[];
      granted_doco_roles: Record<string, string>;
      granted_doco_write_types: Record<string, string[]>;
      granted_org_ids: string[];
      granted_org_roles: Record<string, string>;
      granted_org_write_types: Record<string, string[]>;
      scope: string | null;
      expires_at: Date;
      revoked: boolean;
    }>(
      `SELECT client_id, user_id, token_name,
              granted_doco_ids, granted_doco_roles, granted_doco_write_types,
              granted_org_ids, granted_org_roles, granted_org_write_types,
              scope, expires_at, revoked
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
    // Mint the fresh access token (both paths return one). The
    // granted_doco_roles map carries through unchanged — refresh never
    // widens scope.
    const access_token = mintOpaque(ACCESS_TOKEN_PREFIX);
    const access_expires = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refresh_expires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    const rolesJson = JSON.stringify(row.granted_doco_roles ?? {});
    const docoWriteTypesJson = JSON.stringify(row.granted_doco_write_types ?? {});
    const orgIds = row.granted_org_ids ?? [];
    const orgRolesJson = JSON.stringify(row.granted_org_roles ?? {});
    const orgWriteTypesJson = JSON.stringify(row.granted_org_write_types ?? {});
    await c.query(
      `INSERT INTO oauth_access_tokens
         (token, client_id, user_id, token_name, granted_doco_ids,
          granted_doco_roles, granted_doco_write_types,
          granted_org_ids, granted_org_roles, granted_org_write_types,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        access_token,
        row.client_id,
        row.user_id,
        row.token_name,
        row.granted_doco_ids,
        rolesJson,
        docoWriteTypesJson,
        orgIds,
        orgRolesJson,
        orgWriteTypesJson,
        row.scope,
        access_expires,
      ],
    );

    // Refresh tokens are non-rotating: reissue only the access token and
    // keep the same refresh token, sliding its expiry forward so active use
    // keeps it alive. This lets DOCO_REFRESH be pinned anywhere — a repo
    // .env, cloud env vars, CI secrets — without going stale. Revocation
    // (from /api-keys) is how a token is cut off.
    await c.query("UPDATE oauth_refresh_tokens SET expires_at = $1 WHERE token = $2", [
      refresh_expires,
      args.refresh_token,
    ]);
    return {
      access_token,
      refresh_token: args.refresh_token,
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
export async function revokeToken(
  token: string,
  _hint?: "access_token" | "refresh_token",
): Promise<void> {
  await withClient(async (c) => {
    await c.query("UPDATE oauth_access_tokens  SET revoked = true WHERE token = $1", [token]);
    await c.query("UPDATE oauth_refresh_tokens SET revoked = true WHERE token = $1", [token]);
  });
}

// ---------------------------------------------------------------------------
// Device Authorization Grant (RFC 8628).
//
// For clients that cannot drive a localhost-redirect OAuth flow — they
// can't bind a port, or they're not running on the same machine as the
// user's browser. The client calls POST /oauth/device_authorization,
// gets back a short `user_code` (e.g. "WXYZ-1234") and a verification
// URL. It shows both to the user and polls /oauth/token until the user
// approves in their browser at GET /device.
// ---------------------------------------------------------------------------

const DEVICE_CODE_PREFIX = "doco_dc_";
const DEVICE_CODE_TTL_SECONDS = 15 * 60; // 15 min
const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;
const DEVICE_CODE_SLOWDOWN_THRESHOLD_MS = 2_000; // <2s between polls

/**
 * Generate a user_code formatted as `WXYZ-1234`. Excludes ambiguous
 * glyphs (0/O, 1/I, B/8). 32 + 32 = 1024 distinct values per slot,
 * 2^20 over the four-slot prefix — plenty for the 15-minute window.
 */
function mintUserCode(): string {
  const alphabet = "ACDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (n: number) => {
    let out = "";
    const buf = randomBytes(n);
    for (let i = 0; i < n; i++) out += alphabet[buf[i] % alphabet.length];
    return out;
  };
  return `${pick(4)}-${pick(4)}`;
}

export interface DeviceAuthorizationRow {
  device_code: string;
  user_code: string;
  client_id: string;
  scope: string | null;
  status: "pending" | "approved" | "denied";
  user_id: string | null;
  token_name: string | null;
  granted_doco_ids: string[];
  granted_doco_roles: Record<string, string>;
  granted_doco_write_types: Record<string, string[]>;
  granted_org_ids: string[];
  granted_org_roles: Record<string, string>;
  granted_org_write_types: Record<string, string[]>;
  target_doco_handle: string | null;
  requested_role: string | null;
  expires_at: Date;
  last_polled_at: Date | null;
  created_at: Date;
}

export interface CreateDeviceAuthorizationInput {
  client_id: string;
  scope?: string | null;
  /**
   * Optional. When the client already knows which Doco it needs access
   * to (typically from the project's DOCO.md), it passes the Doco's
   * handle here. The /device approve screen then focuses on that one
   * Doco instead of showing the full picker.
   */
  target_doco_handle?: string | null;
  /**
   * Optional. The role the token is requesting on the target Doco.
   * The /device approve screen pre-fills the dropdown to this value;
   * the human can still adjust before approving.
   */
  requested_role?: string | null;
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * Create a fresh device-authorization row and return the payload the
 * client shows to the user. `baseUrl` is the host origin (e.g.
 * `https://doco.to`); we build verification URLs from it.
 */
export async function createDeviceAuthorization(
  input: CreateDeviceAuthorizationInput,
  baseUrl: string,
): Promise<DeviceAuthorizationResponse> {
  const client = await getClient(input.client_id);
  if (!client) {
    throw new OauthError("invalid_client", `unknown client_id: ${input.client_id}`);
  }
  // Retry on user_code collision (low odds but possible). 5 attempts is
  // dramatically more than the birthday-paradox math would need.
  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    const device_code = mintOpaque(DEVICE_CODE_PREFIX);
    const user_code = mintUserCode();
    const expires_at = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);
    try {
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO oauth_device_authorizations
             (device_code, user_code, client_id, scope,
              target_doco_handle, requested_role, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            device_code,
            user_code,
            input.client_id,
            input.scope ?? null,
            input.target_doco_handle ?? null,
            input.requested_role ?? null,
            expires_at,
          ],
        );
      });
      const trimmed = baseUrl.replace(/\/+$/, "");
      return {
        device_code,
        user_code,
        verification_uri: `${trimmed}/device`,
        verification_uri_complete: `${trimmed}/device?user_code=${encodeURIComponent(user_code)}`,
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
      };
    } catch (err) {
      // Postgres unique violation = 23505. Retry on user_code collision.
      const code = (err as { code?: string })?.code;
      if (code !== "23505") throw err;
    }
  }
  throw new OauthError("server_error", "could not allocate a unique user_code");
}

/**
 * Look up the device-authorization row by user_code. Used by the
 * /device page when the human enters their code.
 */
export async function getDeviceAuthorizationByUserCode(
  user_code: string,
): Promise<DeviceAuthorizationRow | null> {
  if (!user_code) return null;
  return await withClient(async (c) => {
    const r = await c.query<DeviceAuthorizationRow>(
      `SELECT device_code, user_code, client_id, scope, status,
              user_id, token_name, granted_doco_ids, granted_doco_roles,
              granted_doco_write_types,
              granted_org_ids, granted_org_roles, granted_org_write_types,
              target_doco_handle, requested_role, expires_at, last_polled_at, created_at
         FROM oauth_device_authorizations
        WHERE user_code = $1`,
      [user_code.toUpperCase()],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      ...row,
      granted_doco_roles: row.granted_doco_roles ?? {},
      granted_doco_write_types: row.granted_doco_write_types ?? {},
      granted_org_ids: row.granted_org_ids ?? [],
      granted_org_roles: row.granted_org_roles ?? {},
      granted_org_write_types: row.granted_org_write_types ?? {},
    };
  });
}

/**
 * Mark a device-authorization as approved by a signed-in human.
 * `granted_doco_ids` is the set of Docos the user explicitly approved
 * the token to access (subset of the user's own grants). Tokens are
 * NOT minted here — the client's next poll mints + receives them.
 */
export async function approveDeviceAuthorization(args: {
  device_code: string;
  approver_user_id: string;
  token_name: string;
  granted_doco_ids: string[];
  granted_doco_roles?: Record<string, string>;
  granted_doco_write_types?: Record<string, string[]>;
  granted_org_ids?: string[];
  granted_org_roles?: Record<string, string>;
  granted_org_write_types?: Record<string, string[]>;
}): Promise<void> {
  await withTransaction(async (c) => {
    const pending = await c.query<{ client_id: string }>(
      `SELECT client_id
         FROM oauth_device_authorizations
        WHERE device_code = $1
          AND status = 'pending'
          AND expires_at > now()
        FOR UPDATE`,
      [args.device_code],
    );
    const row = pending.rows[0];
    if (!row) {
      throw new OauthError(
        "invalid_grant",
        "device authorization not found, already resolved, or expired",
      );
    }

    const tokenName = normalizeTokenName(args.token_name);
    const grants: GrantSets = {
      granted_doco_ids: args.granted_doco_ids,
      granted_doco_roles: args.granted_doco_roles ?? {},
      granted_doco_write_types: args.granted_doco_write_types ?? {},
      granted_org_ids: args.granted_org_ids ?? [],
      granted_org_roles: args.granted_org_roles ?? {},
      granted_org_write_types: args.granted_org_write_types ?? {},
    };

    await c.query(
      `UPDATE oauth_device_authorizations
          SET status = 'approved',
              user_id = $2,
              token_name = $3,
              granted_doco_ids = $4,
              granted_doco_roles = $5,
              granted_doco_write_types = $6,
              granted_org_ids = $7,
              granted_org_roles = $8,
              granted_org_write_types = $9
        WHERE device_code = $1
          AND status = 'pending'
          AND expires_at > now()`,
      [
        args.device_code,
        args.approver_user_id,
        tokenName,
        grants.granted_doco_ids,
        JSON.stringify(grants.granted_doco_roles),
        JSON.stringify(grants.granted_doco_write_types),
        grants.granted_org_ids,
        JSON.stringify(grants.granted_org_roles),
        JSON.stringify(grants.granted_org_write_types),
      ],
    );
  });
}

export async function denyDeviceAuthorization(device_code: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE oauth_device_authorizations
          SET status = 'denied'
        WHERE device_code = $1
          AND status = 'pending'`,
      [device_code],
    );
  });
}

export type DevicePollResult =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "approved"; tokens: IssuedTokens };

/**
 * Polled by /oauth/token when `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
 * Returns the current state and — on approval — mints the access +
 * refresh tokens and deletes the device-authorization row in one
 * transaction so the same device_code can't mint twice.
 */
export async function pollDeviceAuthorization(args: {
  device_code: string;
  client_id: string;
}): Promise<DevicePollResult> {
  return await withTransaction(async (c) => {
    // SELECT FOR UPDATE so two concurrent polls can't both mint tokens
    // for the same approved authorization.
    const r = await c.query<DeviceAuthorizationRow>(
      `SELECT device_code, user_code, client_id, scope, status,
              user_id, token_name, granted_doco_ids, granted_doco_roles,
              granted_doco_write_types,
              granted_org_ids, granted_org_roles, granted_org_write_types,
              target_doco_handle, requested_role, expires_at, last_polled_at, created_at
         FROM oauth_device_authorizations
        WHERE device_code = $1
        FOR UPDATE`,
      [args.device_code],
    );
    const row = r.rows[0];
    if (!row) {
      throw new OauthError("invalid_grant", "unknown device_code");
    }
    if (row.client_id !== args.client_id) {
      throw new OauthError("invalid_grant", "client_id does not match device_code");
    }
    if (row.expires_at.getTime() <= Date.now()) {
      await c.query("DELETE FROM oauth_device_authorizations WHERE device_code = $1", [
        args.device_code,
      ]);
      return { kind: "expired" };
    }
    // Polling-rate guard. RFC 8628 §3.5: if the client is polling too
    // fast, return slow_down (and don't update last_polled_at — let
    // the next call catch up).
    const now = Date.now();
    if (row.last_polled_at) {
      const gap = now - row.last_polled_at.getTime();
      if (gap < DEVICE_CODE_SLOWDOWN_THRESHOLD_MS) {
        return { kind: "slow_down" };
      }
    }
    await c.query(
      "UPDATE oauth_device_authorizations SET last_polled_at = now() WHERE device_code = $1",
      [args.device_code],
    );

    if (row.status === "denied") {
      await c.query("DELETE FROM oauth_device_authorizations WHERE device_code = $1", [
        args.device_code,
      ]);
      return { kind: "denied" };
    }
    if (row.status === "pending") {
      return { kind: "pending" };
    }
    // status === 'approved' — mint tokens, delete the row in the same tx.
    if (!row.user_id) {
      throw new OauthError("server_error", "approved device_code missing user_id");
    }
    const access_token = mintOpaque(ACCESS_TOKEN_PREFIX);
    const refresh_token = mintOpaque(REFRESH_TOKEN_PREFIX);
    const access_expires = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refresh_expires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    const rolesJson = JSON.stringify(row.granted_doco_roles ?? {});
    const docoWriteTypesJson = JSON.stringify(row.granted_doco_write_types ?? {});
    const orgIds = row.granted_org_ids ?? [];
    const orgRolesJson = JSON.stringify(row.granted_org_roles ?? {});
    const orgWriteTypesJson = JSON.stringify(row.granted_org_write_types ?? {});
    await c.query(
      `INSERT INTO oauth_access_tokens
         (token, client_id, user_id, token_name, granted_doco_ids,
          granted_doco_roles, granted_doco_write_types,
          granted_org_ids, granted_org_roles, granted_org_write_types,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        access_token,
        row.client_id,
        row.user_id,
        row.token_name,
        row.granted_doco_ids,
        rolesJson,
        docoWriteTypesJson,
        orgIds,
        orgRolesJson,
        orgWriteTypesJson,
        row.scope,
        access_expires,
      ],
    );
    await c.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, user_id, token_name, granted_doco_ids,
          granted_doco_roles, granted_doco_write_types,
          granted_org_ids, granted_org_roles, granted_org_write_types,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        refresh_token,
        row.client_id,
        row.user_id,
        row.token_name,
        row.granted_doco_ids,
        rolesJson,
        docoWriteTypesJson,
        orgIds,
        orgRolesJson,
        orgWriteTypesJson,
        row.scope,
        refresh_expires,
      ],
    );
    await c.query("DELETE FROM oauth_device_authorizations WHERE device_code = $1", [
      args.device_code,
    ]);
    return {
      kind: "approved",
      tokens: {
        access_token,
        refresh_token,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: row.scope,
      },
    };
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
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_redirect_uri"
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "server_error";

export class OauthError extends Error {
  readonly code: OauthErrorCode;
  constructor(code: OauthErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "OauthError";
  }
}
