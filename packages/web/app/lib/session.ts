// Session + Principal lookup — Phase 3 Postgres-only
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import { getPrincipalById, getPrincipalByUsername } from "@doco/db";

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
    if (name === COOKIE_NAME && /^principal_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return value;
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
  type: "person" | "agent";
  isHuman: boolean;
  email?: string;
}

function rowToPrincipal(row: {
  id: string;
  username: string;
  email: string | null;
  type: string;
  raw_yaml: string;
}): CurrentPrincipal {
  const fm = (() => {
    try {
      return JSON.parse(row.raw_yaml) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const email = row.email ?? (fm.github_identity as { email?: string } | undefined)?.email ?? null;
  const hasGitHubIdentity = Boolean(
    fm.github_identity &&
      typeof fm.github_identity === "object" &&
      !Array.isArray(fm.github_identity),
  );
  const isHuman = row.type === "person" || hasGitHubIdentity;
  const type: "person" | "agent" = row.type === "agent" ? "agent" : "person";
  const out: CurrentPrincipal = {
    id: row.id,
    username: row.username,
    type,
    isHuman,
  };
  if (typeof email === "string") out.email = email;
  return out;
}

export function isHumanPrincipal(principal: CurrentPrincipal | null | undefined): boolean {
  return principal?.isHuman === true;
}

export async function findPrincipalById(principalId: string): Promise<CurrentPrincipal | null> {
  const row = await getPrincipalById(principalId);
  if (!row) return null;
  return rowToPrincipal(row);
}

export async function findPrincipalByUsername(username: string): Promise<CurrentPrincipal | null> {
  const row = await getPrincipalByUsername(username);
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
 * Legacy 64-hex DOCO_ACCESS bearers, the /agent/<cred>/* URL path,
 * and the ?_a=<cred> query parameter are all removed — the v12
 * cutover migration invalidates any historical credentials, and
 * runtimes get a 401 + WWW-Authenticate that kicks off the OAuth flow.
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
    if (token?.principal_id) {
      const p = await findPrincipalById(token.principal_id);
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

/**
 * Back-compat alias kept while older callers still reference this
 * name. The wire format is now opaque OAuth tokens; the 64-hex
 * shape + URL-path / query-param fallbacks are gone.
 */
export function extractCredential(request: Request): string | null {
  return extractBearer(request);
}
