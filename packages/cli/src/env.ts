// Doco config resolution for the CLI — pulls the bearer DOCO_TOKEN from
// `./.env` (gitignored, secret) and the project's DOCO_ID from
// `./AGENTS.md` (committed, non-secret coordinator). `decision/move-
// doco-id-to-agents-md` (this commit) split the two: the ID is part of
// the project and should ride with git, only the credential goes in the
// secret file. Existing repos that still carry DOCO_ID in `.env` keep
// working via the fallback — read order is env > AGENTS.md > .env so
// the new home wins once it's filled in.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type DocoConfig = { token: string; docoId: string };

/**
 * Read `./.env` into `process.env` for any DOCO_* keys that aren't
 * already set. Lazy: returns immediately if every key is already in env.
 * Used by the capture / patch / supersede / audit commands so they can
 * be invoked from a shell that hasn't sourced .env.
 */
export function loadDotenv(): void {
  for (const k of ["DOCO_TOKEN", "DOCO_ID"] as const) {
    if (process.env[k]) continue;
    try {
      const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\s*export\s+/, "");
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2];
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
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
 * Pull `doco_...` out of the project's AGENTS.md header. The Doco ID
 * lives in the committed bootstrap file (top-of-file metadata line)
 * rather than `.env`, because it's not secret and every contributor
 * needs the same value. Returns the first `doco_<ulid>` match — the
 * template puts it on the first content line, so first-match is right.
 */
export function readDocoIdFromAgentsMd(cwd: string = process.cwd()): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = readFileSync(resolve(cwd, name), "utf8");
      const m = text.match(/\bdoco_[A-Za-z0-9]+/);
      if (m) return m[0];
    } catch {
      // ignore missing files; try the next one
    }
  }
  return null;
}

/**
 * Resolve token + docoId or exit 2 with a missing-env message.
 * Read order: process.env → ./.env (via loadDotenv) → ./AGENTS.md.
 *
 * Existing repos that still carry DOCO_ID in .env keep working (the
 * `loadDotenv` step puts it on process.env first). When the .env entry
 * is dropped — the new convention — the AGENTS.md fallback fills in.
 */
export function requireDocoConfig(): DocoConfig {
  loadDotenv();
  const token = process.env.DOCO_TOKEN ?? "";
  let docoId = process.env.DOCO_ID ?? "";
  if (!docoId) {
    docoId = readDocoIdFromAgentsMd() ?? "";
    if (docoId) process.env.DOCO_ID = docoId;
  }
  const missing: string[] = [];
  if (!token) missing.push("DOCO_TOKEN (./.env)");
  if (!docoId) missing.push("DOCO_ID (./AGENTS.md header)");
  if (missing.length) {
    const cross = "\x1b[31m✗\x1b[0m";
    console.error(
      `${cross} Missing: ${missing.join(", ")}. Run \`doco login --host https://doco.to\` to authorize this CLI session.`,
    );
    process.exit(2);
  }
  return { token, docoId };
}
