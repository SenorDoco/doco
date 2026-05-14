// Slug aliases for Docos. Per D-019: slugs are immutable once set;
// renames and ownership transfers (e.g. claiming a host-bootstrap Doco)
// leave the old slug as a permanent alias to the canonical current
// slug. Same idea as GitHub's repository redirects after rename/transfer
// — old URLs in agents' .env, cross-references, READMEs keep resolving.
//
// Storage: a single `<host-root>/docos/_aliases.yaml` file. Writes are
// atomic (temp + rename). Reads are cached in-memory keyed by file mtime
// so a stale alias map never lingers after a claim.
//
// Resolution rules:
//   - Direct match always wins. If `<owner>/<slug>/doco.yaml` exists,
//     return that — the slug was either never aliased OR the alias was
//     superseded by re-creating a Doco at the same path.
//   - Otherwise walk the alias chain up to MAX_HOPS. Each hop must
//     land on a real `doco.yaml`; if it doesn't, keep walking.
//   - Defensive cycle bound: return null after MAX_HOPS without
//     resolution (shouldn't happen in practice — claim flow only
//     appends new aliases, never overwrites).

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { docoPath, rootDir } from "./db.server";

interface DocoAliasEntry {
  from: string;
  to: string;
  doco_id: string;
  created_at: string;
}

interface DocoAliasesFile {
  aliases: DocoAliasEntry[];
}

const MAX_HOPS = 5;

let cache: { mtimeMs: number; entries: Map<string, DocoAliasEntry> } | null = null;

function aliasFile(): string {
  return join(rootDir(), "docos", "_aliases.yaml");
}

function loadAliases(): Map<string, DocoAliasEntry> {
  const file = aliasFile();
  if (!existsSync(file)) return new Map();
  const m = statSync(file).mtimeMs;
  if (cache && cache.mtimeMs === m) return cache.entries;
  try {
    const parsed = parseYaml(readFileSync(file, "utf8")) as DocoAliasesFile | null;
    const entries = new Map<string, DocoAliasEntry>();
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

export interface DocoSlugResolution {
  ownerSlug: string;
  docoSlug: string;
  redirected: boolean;
}

/**
 * Resolve `<ownerSlug>/<docoSlug>` through the alias map.
 *
 *   - When the direct path has a `doco.yaml`, returns the input unchanged
 *     (`redirected: false`).
 *   - When the direct path has no `doco.yaml` but the alias map has an
 *     entry that leads to a real Doco, returns the canonical slug
 *     (`redirected: true`).
 *   - Otherwise returns null (Doco truly doesn't exist anywhere).
 */
export function resolveDocoSlugAlias(
  ownerSlug: string,
  docoSlug: string,
): DocoSlugResolution | null {
  if (existsSync(join(docoPath(ownerSlug, docoSlug), "doco.yaml"))) {
    return { ownerSlug, docoSlug, redirected: false };
  }
  const aliases = loadAliases();
  let cur = `${ownerSlug}/${docoSlug}`;
  for (let i = 0; i < MAX_HOPS; i++) {
    const entry = aliases.get(cur);
    if (!entry) return null;
    cur = entry.to;
    const slash = cur.indexOf("/");
    if (slash <= 0) return null;
    const o = cur.slice(0, slash);
    const s = cur.slice(slash + 1);
    if (existsSync(join(docoPath(o, s), "doco.yaml"))) {
      return { ownerSlug: o, docoSlug: s, redirected: true };
    }
  }
  return null;
}

/**
 * Append a new alias entry. Idempotent — repeated calls with the same
 * (from, to) pair are no-ops. Atomic via temp file + rename so a crash
 * between write and rename leaves the original intact.
 */
export function recordDocoSlugAlias(
  fromOwner: string,
  fromSlug: string,
  toOwner: string,
  toSlug: string,
  docoId: string,
): void {
  const from = `${fromOwner}/${fromSlug}`;
  const to = `${toOwner}/${toSlug}`;
  if (from === to) return;

  const file = aliasFile();
  let parsed: DocoAliasesFile = { aliases: [] };
  if (existsSync(file)) {
    try {
      const p = parseYaml(readFileSync(file, "utf8")) as DocoAliasesFile | null;
      if (p && Array.isArray(p.aliases)) parsed = p;
    } catch {
      // Corrupt or empty — start fresh; the existing file is moved aside.
    }
  }
  if (parsed.aliases.some((a) => a.from === from && a.to === to)) return;
  parsed.aliases.push({
    from,
    to,
    doco_id: docoId,
    created_at: new Date().toISOString(),
  });

  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, stringifyYaml(parsed));
  renameSync(tmp, file);
  cache = null;
}
