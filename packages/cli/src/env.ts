// Doco config resolution for the CLI. The secret is `DOCO_ACCESS` in
// `./.env`; the project coordinate is the committed URL(s) in
// `./.doco/connections.md`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type DocoConfig = { access: string; docoRef: string; host: string };

/**
 * Doco host the CLI talks to. Defaults to production (`https://doco.to`)
 * for the wide-default path the bootstrap canonical documents. Override
 * via `DOCO_HOST` for local dev / test (`http://127.0.0.1:5173`) — set
 * it in `./.env` alongside `DOCO_ACCESS` (or export inline) and every
 * subcommand will route there.
 */
export const DEFAULT_DOCO_HOST = "https://doco.to";

export function resolveDocoHost(): string {
  loadDotenv();
  const raw = (process.env.DOCO_HOST ?? "").trim();
  if (!raw) return DEFAULT_DOCO_HOST;
  return raw.replace(/\/+$/, "");
}

/**
 * Read `./.env` into `process.env` for any DOCO_* keys that aren't
 * already set. Lazy: returns immediately if every key is already in env.
 * Used by login/bootstrap helpers so they can be invoked from a shell
 * that hasn't sourced .env.
 */
export function loadDotenv(): void {
  for (const k of ["DOCO_ACCESS", "DOCO_HOST"] as const) {
    if (process.env[k]) continue;
    try {
      const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\s*export\s+/, "");
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[m[1]]) process.env[m[1]] = v;
      }
      break;
    } catch {
      break;
    }
  }
}

/**
 * Pull the public Doco coordinate from the project's pointer file.
 * `.doco/connections.md` is a markdown file listing one or more Doco
 * URLs. The first URL wins.
 */
export function readDocoRefFromProject(cwd: string = process.cwd()): string | null {
  try {
    const text = readFileSync(resolve(cwd, ".doco/connections.md"), "utf8");
    const urlMatch = text.match(/https?:\/\/[^/\s)]+\/([A-Za-z0-9][A-Za-z0-9-]*)(?:\/|\b)/);
    if (urlMatch?.[1]) return urlMatch[1];
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve access credential + Doco ref or exit 2 with a missing-config
 * message.
 */
export function requireDocoConfig(): DocoConfig {
  loadDotenv();
  const access = process.env.DOCO_ACCESS ?? "";
  const docoRef = readDocoRefFromProject() ?? "";
  const missing: string[] = [];
  if (!access) missing.push("DOCO_ACCESS (./.env)");
  if (!docoRef) missing.push(".doco/connections.md URL");
  if (missing.length) {
    const cross = "\x1b[31m✗\x1b[0m";
    console.error(
      `${cross} Missing: ${missing.join(", ")}. Run \`doco login --host https://doco.to\` to authorize this CLI session.`,
    );
    process.exit(2);
  }
  return { access, docoRef, host: resolveDocoHost() };
}
