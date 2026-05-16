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

export async function listScopeFiles(docoDir: string): Promise<{ id: string; name: string }[]> {
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
  parent_ids: string[];
  lifecycle: string;
  is_watched: boolean;
  intents: {
    id: string;
    summary: string;
    lifecycle: string;
  }[];
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

export async function listScopeDetails(
  docoDir: string,
  opts: { includeIntents?: boolean } = {},
): Promise<ScopeDetails[]> {
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
        out.push({
          id: row.id,
          name: row.name,
          icon: typeof e.icon === "string" ? e.icon : "",
          parent_ids: Array.isArray(e.scopes) ? (e.scopes as string[]) : [],
          lifecycle: typeof e.lifecycle === "string" ? e.lifecycle : "active",
          is_watched: row.name === "global" || e.watched === true,
          intents: [],
        });
      }

      if (opts.includeIntents && out.length > 0) {
        const byScopeId = new Map(out.map((s) => [s.id, s.intents]));
        const intentRows = await c.query<{
          scope_id: string;
          id: string;
          summary: string;
          lifecycle: string;
        }>(
          `SELECT e.to_id AS scope_id,
                  i.id,
                  COALESCE(i.summary, '') AS summary,
                  COALESCE(i.lifecycle, 'active') AS lifecycle
             FROM edges e
             JOIN intents i ON i.id = e.from_id
                           AND i.doco_id = e.doco_id
            WHERE e.doco_id = $1
              AND e.edge_type = 'in_scope_of'
              AND e.from_node_type = 'intent'
              AND e.to_node_type = 'scope'
              AND COALESCE(i.lifecycle, 'active') IN ('active', 'proposed')
            ORDER BY i.created_at ASC, i.id ASC`,
          [docoId],
        );
        for (const row of intentRows.rows) {
          const intents = byScopeId.get(row.scope_id);
          if (!intents || row.summary.trim().length === 0) continue;
          intents.push({
            id: row.id,
            summary: row.summary,
            lifecycle: row.lifecycle,
          });
        }
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
  lifecycle: string;
  is_watched: boolean;
}

export async function listScopeManifest(docoDir: string): Promise<ScopeManifestEntry[]> {
  const details = await listScopeDetails(docoDir);
  return details.map((d) => ({
    id: d.id,
    name: d.name,
    icon: d.icon,
    lifecycle: d.lifecycle,
    is_watched: d.is_watched,
  }));
}
