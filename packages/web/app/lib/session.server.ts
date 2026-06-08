// Session + User lookup. The session cookie stores the user id (OAuth
// identity).

import { type UserRow, getUserById } from "@doco/db";

const COOKIE_NAME = "doco_session";

export function getSessionPrincipalId(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const parts = header.split(";").map((p) => p.trim());
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const name = p.slice(0, eq);
    const value = decodeURIComponent(p.slice(eq + 1));
    if (name === COOKIE_NAME && /^(user|principal)_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
      return value;
    }
  }
  return null;
}

export function setSessionCookie(principalId: string): string {
  const max = 30 * 24 * 3600;
  return `${COOKIE_NAME}=${encodeURIComponent(principalId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max}`;
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
