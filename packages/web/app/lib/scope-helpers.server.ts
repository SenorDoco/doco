// Server-only helpers for scope reads. Reads scopes from PG.
import { basename, dirname } from "node:path";
import { getDocoBySlug, withClient } from "@doco/db";
import { parse as parseYaml } from "yaml";

export interface DocoMetadata {
  docoId: string;
  ownerId: string;
  displayName: string;
  description: string;
  visibility: "private" | "public";
  slug: string;
}

/**
 * Read a Doco's metadata from Postgres. The `docoDir` argument is a
 * placeholder shaped `<rootDir>/docos/<owner>/<slug>` (see `docoPath` in
 * db.server.ts), so the last two path segments are the slugs.
 */
export async function readDocoMetadata(docoDir: string): Promise<DocoMetadata | null> {
  const docoSlug = basename(docoDir);
  const ownerSlug = basename(dirname(docoDir));
  if (!ownerSlug || !docoSlug) return null;
  const row = await getDocoBySlug(ownerSlug, docoSlug);
  if (!row) return null;
  let description = "";
  let displayName = row.name ?? "";
  try {
    const parsed = parseYaml(row.raw_yaml) as Record<string, unknown>;
    if (typeof parsed.description === "string") description = parsed.description;
    if (!displayName && typeof parsed.display_name === "string") {
      displayName = parsed.display_name;
    }
  } catch {
    // raw_yaml unparseable — fall back to row.name and empty description.
  }
  return {
    docoId: row.id,
    ownerId: row.owner_id,
    displayName,
    description,
    visibility: row.visibility,
    slug: row.doco_slug,
  };
}

async function docoIdFromDir(docoDir: string): Promise<string | null> {
  return (await readDocoMetadata(docoDir))?.docoId ?? null;
}

export async function listScopeFiles(
  docoDir: string,
): Promise<{ id: string; name: string }[]> {
  const docoId = await docoIdFromDir(docoDir);
  if (!docoId) return [];
  try {
    return await withClient(async (c) => {
      const r = await c.query<{ id: string; name: string }>(
        "SELECT id, name FROM scopes WHERE doco_id = $1 ORDER BY name",
        [docoId],
      );
      return r.rows;
    });
  } catch {
    return [];
  }
}

export interface ScopeDetails {
  id: string;
  name: string;
  icon: string;
  /**
   * Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA the scope no longer carries
   * a dedicated `purpose` or `guidelines` field. The first guidance rule
   * (if any) doubles as a readable short summary in scope-list contexts;
   * the full list lives on the scope's `guidance_rules` array.
   */
  short_description: string;
  parent_ids: string[];
  lifecycle: string;
  is_watched: boolean;
}

export async function resolveScopeIcons(
  docoDir: string,
  scopeIds: readonly string[],
): Promise<{ name: string; icon?: string }[]> {
  if (scopeIds.length === 0) return [];
  const all = await listScopeDetails(docoDir);
  const byId = new Map(all.map((s) => [s.id, s]));
  const out: { name: string; icon?: string }[] = [];
  for (const id of scopeIds) {
    const s = byId.get(id);
    if (!s) continue;
    out.push(s.icon ? { name: s.name, icon: s.icon } : { name: s.name });
  }
  return out;
}

export async function listScopeDetails(docoDir: string): Promise<ScopeDetails[]> {
  const docoId = await docoIdFromDir(docoDir);
  if (!docoId) return [];
  const out: ScopeDetails[] = [];
  try {
    await withClient(async (c) => {
      const r = await c.query<{ id: string; name: string; raw_yaml: string }>(
        "SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1",
        [docoId],
      );
      for (const row of r.rows) {
        let e: Record<string, unknown> = {};
        try {
          const parsed = parseYaml(row.raw_yaml);
          if (parsed && typeof parsed === "object") {
            e = parsed as Record<string, unknown>;
          }
        } catch {}
        const firstGuidance = Array.isArray(e.guidance_rules)
          ? (e.guidance_rules as unknown[]).find((s): s is string => typeof s === "string") ?? ""
          : "";
        out.push({
          id: row.id,
          name: row.name,
          icon: typeof e.icon === "string" ? e.icon : "",
          short_description: firstGuidance,
          parent_ids: Array.isArray(e.scopes) ? (e.scopes as string[]) : [],
          lifecycle: typeof e.lifecycle === "string" ? e.lifecycle : "active",
          is_watched: row.name === "constitution" || e.watched === true,
        });
      }
    });
  } catch {
    return [];
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface ScopeManifestEntry {
  id: string;
  name: string;
  icon: string;
  /** Short readable description (first guidance rule, if any). */
  short_description: string;
  lifecycle: string;
  is_watched: boolean;
}

export async function listScopeManifest(
  docoDir: string,
): Promise<ScopeManifestEntry[]> {
  const details = await listScopeDetails(docoDir);
  return details.map((d) => ({
    id: d.id,
    name: d.name,
    icon: d.icon,
    short_description: d.short_description,
    lifecycle: d.lifecycle,
    is_watched: d.is_watched,
  }));
}
