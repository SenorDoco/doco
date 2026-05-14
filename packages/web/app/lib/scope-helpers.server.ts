// Server-only helpers for the scopes/new route. Lives in *.server.ts so
// node:fs / node:path don't leak into the browser bundle.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { openDocoDbAtDir } from "./db.server";

export interface DocoMetadata {
  docoId: string;
  ownerId: string;
  displayName: string;
  description: string;
  visibility: "private" | "public";
  slug: string;
}

/**
 * Read the new Doco's metadata directly from `doco.yaml` — bypassing the
 * cache db so this works even before the first reindex completes.
 */
export function readDocoMetadata(docoDir: string): DocoMetadata | null {
  try {
    const text = readFileSync(join(docoDir, "doco.yaml"), "utf8");
    const parsed = parseYaml(text) as Record<string, unknown>;
    const visibility = parsed.visibility === "public" ? "public" : "private";
    return {
      docoId: String(parsed.id ?? ""),
      ownerId: String(parsed.owner_id ?? ""),
      displayName: String(parsed.display_name ?? ""),
      description:
        typeof parsed.description === "string" ? parsed.description : "",
      visibility,
      slug: String(parsed.slug ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * List existing scopes from the SQLite cache. Returns [] if the cache
 * doesn't exist yet (very fresh Docos pre-first-reindex).
 */
export function listScopeFiles(docoDir: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  try {
    const db = openDocoDbAtDir(docoDir);
    try {
      const rows = db
        .prepare("SELECT id, name FROM scope ORDER BY name")
        .all() as { id: string; name: string }[];
      out.push(...rows);
    } finally {
      db.close();
    }
  } catch {
    // No cache yet — return empty.
  }
  return out;
}

export interface ScopeDetails {
  id: string;
  name: string;
  icon: string;
  purpose: string;
  guidelines: string;
  parent_ids: string[];
  /**
   * Lifecycle state. `"active"` (default) means the scope accepts new
   * members. Any non-active value (`"abandoned"`, `"superseded"`, …)
   * means existing members keep their tag but new captures referencing
   * the scope are rejected. Per the `scopes-are-deprecated-not-deleted`
   * Decision.
   */
  lifecycle: string;
  /**
   * Soft attention signal (ADR-137bis): `watched: true` on the scope's
   * YAML tells contributors to proactively look for opportunities to
   * document into this scope. Not enforced at capture time.
   */
  is_watched: boolean;
}

/**
 * Resolve a list of scope IDs to their { name, icon } pair. Unknown IDs are
 * dropped. Used by the capture renderer to prefix the scope-list header
 * line on every node add/update.
 */
export function resolveScopeIcons(
  docoDir: string,
  scopeIds: readonly string[],
): { name: string; icon?: string }[] {
  if (scopeIds.length === 0) return [];
  const all = listScopeDetails(docoDir);
  const byId = new Map(all.map((s) => [s.id, s]));
  const out: { name: string; icon?: string }[] = [];
  for (const id of scopeIds) {
    const s = byId.get(id);
    if (!s) continue;
    out.push(s.icon ? { name: s.name, icon: s.icon } : { name: s.name });
  }
  return out;
}

/**
 * Richer scope listing — reads from the SQLite cache (built from
 * Postgres rows). Filesystem walk of `<docoDir>/scopes/` is gone
 * (rule_01KRKQDHWNWJAF4YKTMCB2A0D9).
 */
export function listScopeDetails(docoDir: string): ScopeDetails[] {
  const out: ScopeDetails[] = [];
  try {
    const db = openDocoDbAtDir(docoDir);
    try {
      const rows = db
        .prepare("SELECT id, name, raw_json FROM scope")
        .all() as { id: string; name: string; raw_json: string }[];
      for (const r of rows) {
        let e: Record<string, unknown> = {};
        try {
          e = JSON.parse(r.raw_json) as Record<string, unknown>;
        } catch {}
        out.push({
          id: r.id,
          name: r.name,
          icon: typeof e.icon === "string" ? e.icon : "",
          purpose: typeof e.purpose === "string" ? e.purpose : "",
          guidelines: typeof e.guidelines === "string" ? e.guidelines : "",
          parent_ids: Array.isArray(e.scopes) ? (e.scopes as string[]) : [],
          lifecycle: typeof e.lifecycle === "string" ? e.lifecycle : "active",
          // Fifth framework-native behavior of the Constitution scope
          // (decision_01KRKS5H2A5QER84CJ8R4VD36Z): always watched.
          // Projected here so every reader (bootstrap manifest, search
          // pinning, scope manifest, scope list, edit page) sees the
          // invariant even on legacy Docos whose stored YAML predates
          // this rule.
          is_watched: r.name === "constitution" || e.watched === true,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    // No cache yet — return empty.
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * One entry per scope in the agent-facing scope manifest. Slim by
 * design — guidelines are intentionally omitted to keep the bootstrap
 * payload small (agents can fetch /status.json or open the scope page
 * if they need the full prose). `is_watched` is read from the scope's
 * own `watched: true` flag (ADR-137bis) — a soft attention signal
 * telling contributors to proactively look for opportunities to
 * document into this scope. NOT the same as hard-enforced
 * `mandatory_scope` rules on the Constitution.
 */
export interface ScopeManifestEntry {
  id: string;
  name: string;
  icon: string;
  purpose: string;
  lifecycle: string;
  is_watched: boolean;
}

/**
 * Build the scope manifest: every scope in the Doco, tagged with
 * `is_watched` from the scope's own `watched: true` flag. Returns an
 * empty array when the Doco has no scopes/ directory yet.
 */
export function listScopeManifest(docoDir: string): ScopeManifestEntry[] {
  return listScopeDetails(docoDir).map((d) => ({
    id: d.id,
    name: d.name,
    icon: d.icon,
    purpose: d.purpose,
    lifecycle: d.lifecycle,
    is_watched: d.is_watched,
  }));
}
