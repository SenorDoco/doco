// Server-only helpers for scope reads. Lives in *.server.ts so node:fs /
// node:path don't leak into the browser bundle. Reads scopes from PG.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getDocoBySlug, withClient } from "@doco/db";

export interface DocoMetadata {
  docoId: string;
  ownerId: string;
  displayName: string;
  description: string;
  visibility: "private" | "public";
  slug: string;
}

/**
 * Read a Doco's metadata. In filesystem-storage mode (local dev) this
 * reads `<docoDir>/doco.yaml`. In Postgres-storage mode (production) the
 * `docos/` tree doesn't exist on the deployment, so we derive the
 * (ownerSlug, docoSlug) pair from the directory path and query the
 * `docos` table. The `docoDir` is always shaped `<rootDir>/docos/<owner>/<slug>`
 * (see `docoPath` in db.server.ts) so the last two path segments are
 * the slugs.
 */
export async function readDocoMetadata(docoDir: string): Promise<DocoMetadata | null> {
  if (process.env.DOCO_STORAGE === "postgres") {
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
        `SELECT id, name FROM scopes WHERE doco_id = $1 ORDER BY name`,
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
  purpose: string;
  guidelines: string;
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
        `SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1`,
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
        out.push({
          id: row.id,
          name: row.name,
          icon: typeof e.icon === "string" ? e.icon : "",
          purpose: typeof e.purpose === "string" ? e.purpose : "",
          guidelines: typeof e.guidelines === "string" ? e.guidelines : "",
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
  purpose: string;
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
    purpose: d.purpose,
    lifecycle: d.lifecycle,
    is_watched: d.is_watched,
  }));
}
