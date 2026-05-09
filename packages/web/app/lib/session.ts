import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { rootDir } from "./db";
import type { HostUser } from "./host";

const COOKIE_NAME = "evalo_session";

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
  // 30-day session for local dev. HttpOnly so client JS can't read it.
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
  email?: string;
}

export function findPrincipalById(principalId: string): CurrentPrincipal | null {
  const dir = join(rootDir(), "principals");
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
    const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    if (e.id === principalId) {
      const email = (e.github_identity as { email?: string } | undefined)?.email;
      return {
        id: e.id as string,
        username: e.username as string,
        display_name: (e.display_name as string) ?? (e.username as string),
        ...(typeof email === "string" ? { email } : {}),
      };
    }
  }
  return null;
}

/** Read the cookie + resolve to a Principal record, or null if not signed in / unknown. */
export function getCurrentPrincipal(request: Request): CurrentPrincipal | null {
  const id = getSessionPrincipalId(request);
  if (!id) return null;
  return findPrincipalById(id);
}

/** All host Users — used by the sign-in picker. */
export function listSignInCandidates(): HostUser[] {
  const dir = join(rootDir(), "principals");
  if (!existsSync(dir)) return [];
  const out: HostUser[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
    const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    if (e.type !== "human") continue;
    const email = (e.github_identity as { email?: string } | undefined)?.email;
    out.push({
      id: e.id as string,
      username: e.username as string,
      display_name: (e.display_name as string) ?? (e.username as string),
      ...(typeof email === "string" ? { email } : {}),
    });
  }
  return out;
}
