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
  /** Why this scope exists and what belongs inside it. */
  purpose: string;
  icon: string;
  parent_ids: string[];
  lifecycle: string;
  is_watched: boolean;
  /**
   * Generic scope attribute that restricts which node types can be
   * tagged into this scope. Empty array (or absence) means "any node
   * type is allowed". #global ships with ["rule"]
   * (rule_01KRYED1VAT3STXX6XP2GTP7V0).
   */
  allowed_node_types: string[];
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
      const r = await c.query<{
        id: string;
        name: string;
        purpose: string | null;
        raw_yaml: string;
      }>("SELECT id, name, purpose, raw_yaml FROM scopes WHERE doco_id = $1", [docoId]);
      for (const row of r.rows) {
        let e: Record<string, unknown> = {};
        try {
          const parsed = parseYaml(row.raw_yaml);
          if (parsed && typeof parsed === "object") {
            e = parsed as Record<string, unknown>;
          }
        } catch {}
        // Prefer the dedicated column; fall back to the YAML mirror for
        // older rows that haven't been migrated yet.
        const purposeFromColumn = (row.purpose ?? "").trim();
        const purposeFromYaml =
          typeof e.purpose === "string" && e.purpose.trim() !== `Scope: ${row.name}`
            ? e.purpose
            : "";
        const purpose = purposeFromColumn || purposeFromYaml;
        const allowedNodeTypes = Array.isArray(e.allowed_node_types)
          ? (e.allowed_node_types as unknown[]).filter((v): v is string => typeof v === "string")
          : [];
        out.push({
          id: row.id,
          name: row.name,
          purpose,
          icon: typeof e.icon === "string" ? e.icon : "",
          parent_ids: Array.isArray(e.scopes) ? (e.scopes as string[]) : [],
          lifecycle: typeof e.lifecycle === "string" ? e.lifecycle : "active",
          is_watched: row.name === "#global" || row.name === "global" || e.watched === true,
          allowed_node_types: allowedNodeTypes,
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
  /** Why this scope exists and what belongs inside it. */
  purpose: string;
  icon: string;
  lifecycle: string;
  is_watched: boolean;
  /**
   * Generic scope attribute that restricts which node types are accepted
   * into this scope. Empty array means "no restriction". #global ships
   * with ["rule"]; the framework rejects POSTs of any other node type
   * whose `scopes` list includes such a scope
   * (rule_01KRYED1VAT3STXX6XP2GTP7V0).
   */
  allowed_node_types: string[];
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
    purpose: d.purpose,
    icon: d.icon,
    lifecycle: d.lifecycle,
    is_watched: d.is_watched,
    allowed_node_types: d.allowed_node_types,
  }));
}

export async function listLiveScopeManifest(docoDir: string): Promise<ScopeManifestEntry[]> {
  return (await listScopeManifest(docoDir)).filter((s) => isLiveScopeLifecycle(s.lifecycle));
}
