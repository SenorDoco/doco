// Username aliases for Principals. Symmetric extension of the slug
// alias system in doco-aliases.server.ts. When a Principal is renamed
// (or a host transfers ownership of an org), every `/<old-username>/*`
// URL must keep resolving to the new canonical username — same idea
// as GitHub's username history.
//
// Storage: `<host-root>/principals/_aliases.yaml`. Format mirrors the
// doco alias file: array of {from, to, principal_id, created_at}.
// Resolution: direct match wins (if `/principals/<username>.yaml`
// exists — but the principals/ dir is keyed by principal_id not
// username, so we check the cache/db); otherwise walk the alias chain.
//
// This module is infrastructure: the host has no Principal-rename
// route today, so `recordPrincipalUsernameAlias` is unused until
// someone wires a rename flow. The resolver IS wired into route
// loaders so URLs survive whenever that rename flow lands.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { rootDir } from "./db.server";

interface PrincipalAliasEntry {
  from: string;
  to: string;
  principal_id: string;
  created_at: string;
}

interface PrincipalAliasesFile {
  aliases: PrincipalAliasEntry[];
}

const MAX_HOPS = 5;

let cache: { mtimeMs: number; entries: Map<string, PrincipalAliasEntry> } | null = null;

function aliasFile(): string {
  return join(rootDir(), "principals", "_aliases.yaml");
}

function loadAliases(): Map<string, PrincipalAliasEntry> {
  const file = aliasFile();
  if (!existsSync(file)) return new Map();
  const m = statSync(file).mtimeMs;
  if (cache && cache.mtimeMs === m) return cache.entries;
  try {
    const parsed = parseYaml(readFileSync(file, "utf8")) as PrincipalAliasesFile | null;
    const entries = new Map<string, PrincipalAliasEntry>();
    if (parsed && Array.isArray(parsed.aliases)) {
      for (const a of parsed.aliases) {
        if (typeof a.from === "string" && typeof a.to === "string") {
          entries.set(a.from, a);
        }
      }
    }
    cache = { mtimeMs: m, entries };
    return entries;
  } catch {
    return new Map();
  }
}

export interface UsernameResolution {
  canonical: string;
  redirected: boolean;
}

/**
 * Resolve `<username>` through the alias map. Returns either:
 *   - `{canonical: <input>, redirected: false}` when the input is
 *     already canonical (no alias entry).
 *   - `{canonical: <new>, redirected: true}` when an alias chain
 *     leads to a different canonical username.
 *
 * Never returns null — if the chain depth would exceed MAX_HOPS,
 * stops walking and returns the current value (defensive against
 * cycles). The caller is responsible for verifying the canonical
 * username actually exists (e.g. via `getPrincipalByUsername`) —
 * the alias resolver only redirects; existence is the route's job.
 */
export function resolvePrincipalUsernameAlias(
  username: string,
): UsernameResolution {
  const aliases = loadAliases();
  if (!aliases.has(username)) {
    return { canonical: username, redirected: false };
  }
  let cur = username;
  for (let i = 0; i < MAX_HOPS; i++) {
    const entry = aliases.get(cur);
    if (!entry) return { canonical: cur, redirected: cur !== username };
    cur = entry.to;
  }
  return { canonical: cur, redirected: cur !== username };
}

/**
 * Append a new alias entry. Idempotent — repeated calls with the same
 * (from, to) are no-ops. Atomic via temp + rename.
 */
export function recordPrincipalUsernameAlias(
  fromUsername: string,
  toUsername: string,
  principalId: string,
): void {
  if (fromUsername === toUsername) return;
  const file = aliasFile();
  let parsed: PrincipalAliasesFile = { aliases: [] };
  if (existsSync(file)) {
    try {
      const p = parseYaml(readFileSync(file, "utf8")) as PrincipalAliasesFile | null;
      if (p && Array.isArray(p.aliases)) parsed = p;
    } catch {
      // Corrupt or empty — start fresh.
    }
  }
  if (
    parsed.aliases.some(
      (a) => a.from === fromUsername && a.to === toUsername,
    )
  ) {
    return;
  }
  parsed.aliases.push({
    from: fromUsername,
    to: toUsername,
    principal_id: principalId,
    created_at: new Date().toISOString(),
  });

  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, stringifyYaml(parsed));
  renameSync(tmp, file);
  cache = null;
}
