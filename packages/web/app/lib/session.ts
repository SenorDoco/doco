// Session + Principal lookup — Phase 3 Postgres-only
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import { getPrincipalById, getPrincipalByUsername } from "@doco/db";
import { rootDir } from "./db.server";

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
  display_name: string;
  type: "person" | "agent";
  email?: string;
}

function rowToPrincipal(row: {
  id: string;
  username: string;
  display_name: string | null;
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
  const email =
    row.email ?? (fm.github_identity as { email?: string } | undefined)?.email ?? null;
  const type: "person" | "agent" = row.type === "agent" ? "agent" : "person";
  const out: CurrentPrincipal = {
    id: row.id,
    username: row.username,
    display_name: row.display_name ?? row.username,
    type,
  };
  if (typeof email === "string") out.email = email;
  return out;
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
 *   2. URL path: `/agent/<credential>/...` — the credential is the path
 *      segment that follows `/agent/`. This is what an agent reaches
 *      when it calls `${DOCO_URL}<resource>` directly.
 *   3. `?_a=<credential>` query parameter — used internally by the
 *      `/agent/<credential>/*` 308 redirect so the credential survives
 *      to the destination route without going back into the path.
 *   4. Legacy `Authorization: Bearer <credential>` header — kept while
 *      pre-DOCO_URL bootstraps cycle out; new onboarding never emits
 *      this form.
 */
export async function getCurrentPrincipalAsync(
  request: Request,
): Promise<CurrentPrincipal | null> {
  const cookieId = getSessionPrincipalId(request);
  if (cookieId) {
    const fromCookie = await findPrincipalById(cookieId);
    if (fromCookie) return fromCookie;
  }
  const credential = extractCredential(request);
  if (credential) {
    const { TokenStore } = await import("./agent-token-store.server");
    const store = TokenStore.forDoco(rootDir());
    const session = await store.resolve(credential);
    if (session?.principal_id) {
      const p = await findPrincipalById(session.principal_id);
      if (p) return p;
    }
  }
  return null;
}

const CREDENTIAL_HEX_RE = /^[0-9a-f]{64}$/;
const AGENT_PATH_RE = /^\/agent\/([0-9a-f]{64})(?:\/|$)/;

/**
 * Extract the agent credential from a request. Order:
 *   1. URL path `/agent/<credential>/...`
 *   2. `?_a=<credential>` query param
 *   3. Legacy `Authorization: Bearer <credential>` header
 * Returns null if no credential is present or the candidate isn't a
 * well-formed 64-char hex string.
 */
export function extractCredential(request: Request): string | null {
  const url = new URL(request.url);
  const pathMatch = AGENT_PATH_RE.exec(url.pathname);
  if (pathMatch && pathMatch[1]) return pathMatch[1];
  const qa = url.searchParams.get("_a");
  if (qa && CREDENTIAL_HEX_RE.test(qa)) return qa;
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const t = m ? (m[1] ?? "").trim() : "";
    if (t && CREDENTIAL_HEX_RE.test(t)) return t;
  }
  return null;
}

