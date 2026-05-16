// Helpers for scope-wide bulk operations: activate, draft, validate
// (decision_01KRRR5BQ16ASY8HQEE0V499YG / v7). The scope endpoints in
// `routes/$ownerSlug.$docoSlug.api.scopes.$id.<verb>.json.tsx` share these.
//
// Operations enumerate nodes by walking `in_scope_of` edges. Activate
// runs the rules engine on each candidate before persisting (per v7:
// completeness rules fire on the now-active candidate and may reject
// the bulk flip). Draft and validate don't persist on failure / don't
// persist at all, respectively.

import { NODE_TABLES, withClient } from "@doco/db";
import { parse as parseYaml } from "yaml";
import { runScopeRules } from "./capture.server";

/**
 * Find scope_id + every descendant scope_id (scopes whose `scopes`
 * array transitively includes the root). BFS over the parent-id graph;
 * stable on hierarchies that fit in memory.
 */
export async function enumerateScopeAndDescendants(
  docoId: string,
  rootScopeId: string,
): Promise<Set<string>> {
  const result = new Set<string>([rootScopeId]);
  const all = await withClient((c) =>
    c.query<{ id: string; raw_yaml: string }>(
      "SELECT id, raw_yaml FROM scopes WHERE doco_id = $1",
      [docoId],
    ),
  );
  const parentsOf = new Map<string, string[]>();
  for (const row of all.rows) {
    let parents: string[] = [];
    try {
      const fm = JSON.parse(row.raw_yaml);
      if (fm && Array.isArray(fm.scopes)) {
        parents = (fm.scopes as unknown[]).filter(
          (s): s is string => typeof s === "string",
        );
      }
    } catch {
      try {
        const fm = parseYaml(row.raw_yaml) as Record<string, unknown> | null;
        if (fm && Array.isArray(fm.scopes)) {
          parents = (fm.scopes as unknown[]).filter(
            (s): s is string => typeof s === "string",
          );
        }
      } catch {
        /* skip */
      }
    }
    parentsOf.set(row.id, parents);
  }
  let added = true;
  while (added) {
    added = false;
    for (const [id, parents] of parentsOf) {
      if (result.has(id)) continue;
      if (parents.some((p) => result.has(p))) {
        result.add(id);
        added = true;
      }
    }
  }
  return result;
}

export interface ScopeMember {
  id: string;
  table: string;
  node_type: string;
  fm: Record<string, unknown>;
  raw_yaml: string;
}

/**
 * Load every entity tagged `in_scope_of` any of the given scopes, plus
 * each entity's parsed frontmatter for lifecycle / rules work. Batched
 * by backing table.
 */
export async function loadMembersOfScopes(
  docoId: string,
  scopeIds: Set<string>,
): Promise<ScopeMember[]> {
  if (scopeIds.size === 0) return [];
  const memberRows = await withClient((c) =>
    c.query<{ from_id: string }>(
      `SELECT DISTINCT from_id FROM edges
        WHERE doco_id = $1
          AND edge_type = 'in_scope_of'
          AND to_id = ANY($2::text[])`,
      [docoId, Array.from(scopeIds)],
    ),
  );
  const byTable = new Map<string, string[]>();
  for (const row of memberRows.rows) {
    const idx = row.from_id.indexOf("_");
    if (idx === -1) continue;
    const nodeType = row.from_id.slice(0, idx);
    const spec = NODE_TABLES[nodeType];
    if (!spec) continue;
    const arr = byTable.get(spec.table) ?? [];
    arr.push(row.from_id);
    byTable.set(spec.table, arr);
  }
  const out: ScopeMember[] = [];
  await withClient(async (c) => {
    for (const [table, ids] of byTable) {
      if (ids.length === 0) continue;
      const r = await c.query<{ id: string; raw_yaml: string }>(
        `SELECT id, raw_yaml FROM ${table}
          WHERE doco_id = $1 AND id = ANY($2::text[])`,
        [docoId, ids],
      );
      for (const row of r.rows) {
        let fm: Record<string, unknown> | null = null;
        try {
          fm = JSON.parse(row.raw_yaml);
        } catch {
          try {
            fm = parseYaml(row.raw_yaml) as Record<string, unknown>;
          } catch {
            fm = null;
          }
        }
        if (!fm) continue;
        const nodeType = typeof fm.node_type === "string" ? fm.node_type : "";
        out.push({ id: row.id, table, node_type: nodeType, fm, raw_yaml: row.raw_yaml });
      }
    }
  });
  return out;
}

export interface ValidationResult {
  id: string;
  node_type: string;
  ok: boolean;
  error?: string;
}

/**
 * Re-evaluate the rules engine against every member of the scope (with
 * its current lifecycle). Pure: no DB writes. Used by `scope validate`
 * and as the dry-run step inside `scope activate`.
 */
export async function validateMembers(opts: {
  docoDir: string;
  ownerSlug: string;
  docoSlug: string;
  members: ScopeMember[];
  /**
   * Optional lifecycle override applied to every member's frontmatter
   * before rules evaluation — used by `activate` to ask "would these
   * pass if I flipped them all to `active`?".
   */
  overrideLifecycle?: string;
}): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const m of opts.members) {
    const entityFm =
      opts.overrideLifecycle && m.fm.lifecycle !== opts.overrideLifecycle
        ? { ...m.fm, lifecycle: opts.overrideLifecycle }
        : m.fm;
    const ruleResult = await runScopeRules({
      docoDir: opts.docoDir,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
      entityFm,
    });
    if (ruleResult && "error" in ruleResult) {
      results.push({ id: m.id, node_type: m.node_type, ok: false, error: ruleResult.error });
    } else {
      results.push({ id: m.id, node_type: m.node_type, ok: true });
    }
  }
  return results;
}

/**
 * Bulk-patch members' lifecycle field. Used by `activate` (after
 * validation) and `draft` (no validation). Updates raw_yaml + the
 * `lifecycle` mirror column. Does NOT reindex — the caller is
 * responsible.
 */
export async function bulkUpdateLifecycle(opts: {
  members: ScopeMember[];
  targetLifecycle: string;
  /** Only flip members whose current lifecycle matches this set (e.g.,
   *  `["drafted"]` so `activate` skips already-active rows). */
  onlyFromLifecycles?: string[];
}): Promise<string[]> {
  const updatedIds: string[] = [];
  await withClient(async (c) => {
    for (const m of opts.members) {
      const current = typeof m.fm.lifecycle === "string" ? m.fm.lifecycle : "active";
      if (opts.onlyFromLifecycles && !opts.onlyFromLifecycles.includes(current)) continue;
      if (current === opts.targetLifecycle) continue;
      const newFm = { ...m.fm, lifecycle: opts.targetLifecycle };
      const newRaw = JSON.stringify(newFm);
      await c.query(
        `UPDATE ${m.table} SET raw_yaml = $1, lifecycle = $2, updated_at = now() WHERE id = $3`,
        [newRaw, opts.targetLifecycle, m.id],
      );
      updatedIds.push(m.id);
    }
  });
  return updatedIds;
}

/**
 * Append a rule id to a scope's `excluded_rules` array. Idempotent.
 */
export async function appendExcludedRule(opts: {
  scopeId: string;
  ruleId: string;
}): Promise<{ updated: boolean }> {
  return withClient(async (c) => {
    const r = await c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
      [opts.scopeId],
    );
    if (!r.rows[0]) throw new Error(`Scope not found: ${opts.scopeId}`);
    let fm: Record<string, unknown>;
    try {
      fm = JSON.parse(r.rows[0].raw_yaml);
    } catch {
      fm = parseYaml(r.rows[0].raw_yaml) as Record<string, unknown>;
    }
    const existing = Array.isArray(fm.excluded_rules)
      ? (fm.excluded_rules as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    if (existing.includes(opts.ruleId)) return { updated: false };
    fm.excluded_rules = [...existing, opts.ruleId];
    await c.query(
      "UPDATE scopes SET raw_yaml = $1, updated_at = now() WHERE id = $2",
      [JSON.stringify(fm), opts.scopeId],
    );
    return { updated: true };
  });
}
