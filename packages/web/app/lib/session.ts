// Session + Principal lookup — Phase 3 Postgres-only
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import { getPrincipalById, getPrincipalByUsername, listPrincipals } from "@doco/db";
import { rootDir } from "./db.server";
import type { HostUser } from "./host";

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
 * Like `getCurrentPrincipal` but also accepts an `Authorization: Bearer
 * <DOCO_TOKEN>` header so agents can authenticate the same way people do.
 */
export async function getCurrentPrincipalAsync(
  request: Request,
): Promise<CurrentPrincipal | null> {
  const cookieId = getSessionPrincipalId(request);
  if (cookieId) {
    const fromCookie = await findPrincipalById(cookieId);
    if (fromCookie) return fromCookie;
  }
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m ? (m[1] ?? "").trim() : "";
    if (token) {
      const { TokenStore } = await import("@doco/api");
      const store = TokenStore.forDoco(rootDir());
      const session = await store.resolve(token);
      if (session?.principal_id) {
        const p = await findPrincipalById(session.principal_id);
        if (p) return p;
      }
    }
  }
  return null;
}

/** All host Users — used by the sign-in picker. */
export async function listSignInCandidates(): Promise<HostUser[]> {
  const rows = await listPrincipals({ type: "human" });
  return rows.map((r) => {
    const fm = JSON.parse(r.raw_yaml) as Record<string, unknown>;
    const email =
      r.email ?? (fm.github_identity as { email?: string } | undefined)?.email ?? null;
    const out: HostUser = {
      id: r.id,
      username: r.username,
      display_name: r.display_name ?? r.username,
    };
    if (typeof email === "string") out.email = email;
    return out;
  });
}
