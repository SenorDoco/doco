// Session + User lookup. The session cookie seals the signed-in user's id
// with the server's key (decision_01M4GKEM9P2P6F6Q7JWVP9ATVG), so only a
// cookie the server set signs anyone in.

import { type UserRow, getUserById } from "@doco/db";
import { readCookie } from "./cookie";
import { openToken, sealToken } from "./secret-box.server";

const COOKIE_NAME = "doco_session";
const SESSION_SECONDS = 30 * 24 * 3600;

export function getSessionPrincipalId(request: Request, now = Date.now()): string | null {
  const token = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (!token) return null;
  const id = openToken(token, now);
  return typeof id === "string" && /^(user|principal)_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id : null;
}

/** The `doco_session=…` pair that signs `principalId` in: the Set-Cookie
 *  value's head, and the Cookie header for the server's own calls as them. */
export function sessionCookie(principalId: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(sealToken(principalId, SESSION_SECONDS * 1000))}`;
}

export function setSessionCookie(principalId: string): string {
  return `${sessionCookie(principalId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export interface CurrentPrincipal {
  id: string;
  username: string;
  type: "person";
  isHuman: boolean;
  email?: string;
}

// The single source of truth for "is this the host superadmin?". The admin
// dashboards and the agent-diagnostics surfaces all gate on the host owner's
// username; centralizing the literal here keeps that one definition instead of
// a copy scattered across every admin route.
export const SUPERADMIN_USERNAME = "torrenegra";

export function isSuperadmin(username: string | null | undefined): boolean {
  return username === SUPERADMIN_USERNAME;
}

/** Human-facing display name for a user row. */
export function userDisplayName(row: {
  id: string;
  github_login: string | null;
  data: Record<string, unknown>;
}): string {
  const named = row.data?.name ?? row.data?.display_name;
  if (typeof named === "string" && named.trim()) return named.trim();
  return row.github_login ?? row.id;
}

function rowToPrincipal(row: UserRow): CurrentPrincipal {
  const out: CurrentPrincipal = {
    id: row.id,
    username: userDisplayName(row),
    type: "person",
    isHuman: true,
  };
  if (row.email) out.email = row.email;
  return out;
}

export function isHumanPrincipal(principal: CurrentPrincipal | null | undefined): boolean {
  return principal?.isHuman === true;
}

export async function findPrincipalById(principalId: string): Promise<CurrentPrincipal | null> {
  const row = await getUserById(principalId);
  if (!row) return null;
  return rowToPrincipal(row);
}

export async function getCurrentPrincipal(request: Request): Promise<CurrentPrincipal | null> {
  const id = getSessionPrincipalId(request);
  if (!id) return null;
  return findPrincipalById(id);
}

/**
 * Resolve the calling Principal across all supported authentication
 * mechanisms — in priority order:
 *
 *   1. `doco_session` cookie (browser users).
 *   2. `Authorization: Bearer <oauth-access-token>` header — OAuth 2.1
 *      tokens issued via /oauth/token (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).
 *
 * OAuth is the only bearer credential path for API callers. Runtimes
 * without a valid token get a 401 + WWW-Authenticate that kicks off
 * the OAuth flow.
 */
export async function getCurrentPrincipalAsync(request: Request): Promise<CurrentPrincipal | null> {
  const cookieId = getSessionPrincipalId(request);
  if (cookieId) {
    const fromCookie = await findPrincipalById(cookieId);
    if (fromCookie) return fromCookie;
  }
  const credential = extractBearer(request);
  if (credential) {
    const { validateAccessToken } = await import("./oauth-server.server");
    const token = await validateAccessToken(credential);
    if (token?.user_id) {
      const p = await findPrincipalById(token.user_id);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Extract whatever's in the `Authorization: Bearer …` header. The
 * value is opaque at this layer — OAuth token validation runs in
 * `validateAccessToken`. Returns null when the header is missing or
 * malformed.
 */
export function extractBearer(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const t = m ? (m[1] ?? "").trim() : "";
  return t || null;
}
