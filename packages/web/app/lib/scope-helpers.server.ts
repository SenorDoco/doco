// Server-only helpers for scope reads. Reads scopes from PG.
import { basename } from "node:path";
import { getDocoByHandle, withClient } from "@doco/db";
import { parse as parseYaml } from "yaml";
import { isLiveScopeLifecycle } from "~/lib/scope-lifecycle";

export interface DocoMetadata {
  docoId: string;
  /** Public globally-unique URL identifier. */
  handle: string;
  ownerId: string;
  displayName: string;
  description: string;
  visibility: "private" | "public";
}

/**
 * Read a Doco's metadata from Postgres. `docoDir` is a placeholder
 * built by `docoPath(handle)` — its basename is the handle. Lookup
 * keys off `handle` directly.
 */
export async function readDocoMetadata(docoDir: string): Promise<DocoMetadata | null> {
  const handle = basename(docoDir);
  if (!handle) return null;
  const row = await getDocoByHandle(handle);
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
    handle: row.handle,
    ownerId: row.owner_id,
    displayName,
    description,
    visibility: row.visibility,
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
  intent_ids: string[];
  primary_intent: {
    id: string;
    summary: string;
    lifecycle: string;
  } | null;
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
  opts: { includePrimaryIntent?: boolean } = {},
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
          is_watched: row.name === "#global" || row.name === "global" || e.watched === true,
          intent_ids: Array.isArray(e.intent_ids)
            ? e.intent_ids.filter((id): id is string => typeof id === "string")
            : [],
          primary_intent: null,
        });
      }

      if (opts.includePrimaryIntent && out.length > 0) {
        const explicitIds = [
          ...new Set(
            out
              .map((s) => (s.intent_ids.length === 1 ? s.intent_ids[0] : null))
              .filter((id): id is string => typeof id === "string" && id.length > 0),
          ),
        ];
        const explicitById = new Map<string, ScopeDetails["primary_intent"]>();
        if (explicitIds.length > 0) {
          const explicitRows = await c.query<{
            id: string;
            summary: string;
            lifecycle: string;
          }>(
            `SELECT id,
                    COALESCE(summary, '') AS summary,
                    COALESCE(lifecycle, 'active') AS lifecycle
               FROM intents
              WHERE doco_id = $1
                AND id = ANY($2::text[])`,
            [docoId, explicitIds],
          );
          for (const row of explicitRows.rows) {
            if (row.summary.trim().length === 0) continue;
            explicitById.set(row.id, {
              id: row.id,
              summary: row.summary,
              lifecycle: row.lifecycle,
            });
          }
        }

        for (const scope of out) {
          const mainIntentId = scope.intent_ids.length === 1 ? scope.intent_ids[0] : null;
          if (!mainIntentId) continue;
          scope.primary_intent = explicitById.get(mainIntentId) ?? null;
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
  /** Count of user-captured nodes (decisions, rules, intents, actions,
   *  logs, references, evals, ideas) tagged `in_scope_of` this scope.
   *  Optional because not every manifest call populates it — see
   *  `loadBootstrapContext` which enriches the manifest so the
   *  scope_population overlay can render a "bootstrapped vs empty"
   *  checklist. Undefined = not loaded; 0 = explicitly empty. */
  node_count?: number;
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

export async function listLiveScopeManifest(docoDir: string): Promise<ScopeManifestEntry[]> {
  return (await listScopeManifest(docoDir)).filter((s) => isLiveScopeLifecycle(s.lifecycle));
}
