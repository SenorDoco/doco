// Shared filter logic for /search.json and /search HTML page. Both
// surfaces accept the same `lifecycle` / `node_type` / `scope` filters
// applied BEFORE the cosine top-N slice. See the Decision
// `what-shape-do-the-search-filters-take-and-how-do-defaults`.
import type { PoolClient } from "pg";
import { parse as parseYaml } from "yaml";

/**
 * Parsed filter spec. `null` for a field means "no filter" (everything
 * passes). `lifecycle: null` is the special "wildcard" state — see
 * parseSearchFilters.
 */
export interface SearchFilters {
  /** Allowed lifecycle values. `null` = no filter (all values). */
  lifecycle: string[] | null;
  /** Allowed node types. `null` = no filter (all types). */
  nodeType: string[] | null;
  /** Allowed scope names. `null` = no filter (any scope OR none). */
  scope: string[] | null;
  /** Top-N to return after filtering + cosine. */
  limit: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Lifecycle values that signal the entity should be hidden by default.
 * Other values (active, accepted, …) are treated as "current" and surface
 * in default search results.
 */
export const HIDDEN_BY_DEFAULT_LIFECYCLE_VALUES = [
  "succeeded",
  "superseded",
  "abandoned",
  "failed",
] as const;

export function parseSearchFilters(params: URLSearchParams, facets: FilterFacets): SearchFilters {
  const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, rawLimit))
    : DEFAULT_LIMIT;

  const lifecycleVals = readMulti(params, "lifecycle");
  let lifecycle: string[] | null;
  if (lifecycleVals === null) {
    const hiddenByDefault = new Set<string>(HIDDEN_BY_DEFAULT_LIFECYCLE_VALUES);
    lifecycle = facets.lifecycle.map((f) => f.value).filter((v) => !hiddenByDefault.has(v));
  } else if (lifecycleVals.length === 1 && lifecycleVals[0] === "*") {
    lifecycle = null;
  } else {
    lifecycle = lifecycleVals;
  }

  const nodeTypeVals = readMulti(params, "node_type");
  let nodeType: string[] | null;
  if (nodeTypeVals === null) {
    nodeType = facets.nodeType.map((f) => f.value);
  } else if (nodeTypeVals.length === 1 && nodeTypeVals[0] === "*") {
    nodeType = null;
  } else {
    nodeType = nodeTypeVals;
  }

  const scopeVals = readMulti(params, "scope");
  let scope: string[] | null;
  if (scopeVals === null) {
    scope = facets.scope.map((f) => f.name);
  } else if (scopeVals.length === 1 && scopeVals[0] === "*") {
    scope = null;
  } else {
    scope = scopeVals;
  }

  return { lifecycle, nodeType, scope, limit };
}

function readMulti(params: URLSearchParams, key: string): string[] | null {
  const all = params.getAll(key);
  if (all.length === 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of all) {
    for (const tok of v.split(",")) {
      const t = tok.trim();
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Doco-scoped per-type tables (PG plural names). Each carries a
 * `lifecycle` column directly. principals + organizations are
 * host-level, so they don't filter on doco_id.
 */
const PG_DOCO_TABLES_WITH_LIFECYCLE = [
  "intents",
  "ideas",
  "rules",
  "decisions",
  "actions",
  "logs",
  "evals",
  "reference_entities",
  "scopes",
] as const;

/** Map from external node_type (singular) → PG table (plural). */
const NODE_TYPE_TO_TABLE: Record<string, string> = {
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "reference_entities",
  scope: "scopes",
  principal: "principals",
  organization: "organizations",
};

/** Inverse: PG table → external node_type used on the wire. */
const TABLE_TO_NODE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_TYPE_TO_TABLE).map(([nt, tbl]) => [tbl, nt]),
);

export async function resolveFilteredCandidates(
  c: PoolClient,
  docoId: string,
  filters: SearchFilters,
): Promise<Set<string> | null> {
  if (filters.lifecycle === null && filters.nodeType === null && filters.scope === null) {
    return null;
  }

  let lifecycleIds: Set<string> | null = null;
  if (filters.lifecycle !== null) {
    lifecycleIds = new Set();
    for (const t of PG_DOCO_TABLES_WITH_LIFECYCLE) {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${t}
          WHERE doco_id = $1
            AND COALESCE(lifecycle, 'active') = ANY($2::text[])`,
        [docoId, filters.lifecycle],
      );
      for (const row of r.rows) lifecycleIds.add(row.id);
    }
  }

  let nodeTypeIds: Set<string> | null = null;
  if (filters.nodeType !== null) {
    nodeTypeIds = new Set();
    for (const nt of filters.nodeType) {
      const table = NODE_TYPE_TO_TABLE[nt];
      if (!table) continue;
      if (table === "principals" || table === "organizations") continue;
      const r = await c.query<{ id: string }>(`SELECT id FROM ${table} WHERE doco_id = $1`, [
        docoId,
      ]);
      for (const row of r.rows) nodeTypeIds.add(row.id);
    }
  }

  let scopeIds: Set<string> | null = null;
  if (filters.scope !== null) {
    scopeIds = new Set();
    const scopeRows = (
      await c.query<{ id: string }>(
        "SELECT id FROM scopes WHERE doco_id = $1 AND name = ANY($2::text[])",
        [docoId, filters.scope],
      )
    ).rows;
    if (scopeRows.length > 0) {
      const edgeRows = (
        await c.query<{ from_id: string }>(
          `SELECT from_id FROM edges
            WHERE edge_type = 'in_scope_of'
              AND to_id = ANY($1::text[])
              AND doco_id = $2`,
          [scopeRows.map((r: { id: string }) => r.id), docoId],
        )
      ).rows;
      for (const r of edgeRows) scopeIds.add(r.from_id);
    }
  }

  const sets = [lifecycleIds, nodeTypeIds, scopeIds].filter((s): s is Set<string> => s !== null);
  if (sets.length === 0) return null;
  if (sets.length === 1) return sets[0];

  sets.sort((a, b) => a.size - b.size);
  const out = new Set<string>();
  for (const id of sets[0]) {
    if (sets.slice(1).every((s) => s.has(id))) out.add(id);
  }
  return out;
}

export interface FilterFacets {
  lifecycle: { value: string; count: number }[];
  nodeType: { value: string; count: number }[];
  scope: { name: string; count: number; icon: string | null }[];
}

export async function computeFilterFacets(c: PoolClient, docoId: string): Promise<FilterFacets> {
  const lifecycleCounts = new Map<string, number>();
  for (const t of PG_DOCO_TABLES_WITH_LIFECYCLE) {
    const r = await c.query<{ value: string; n: string }>(
      `SELECT COALESCE(lifecycle, 'active') AS value, COUNT(*)::text AS n
         FROM ${t}
        WHERE doco_id = $1
        GROUP BY value`,
      [docoId],
    );
    for (const row of r.rows) {
      const n = Number(row.n);
      lifecycleCounts.set(row.value, (lifecycleCounts.get(row.value) ?? 0) + n);
    }
  }

  const nodeTypeCounts: { value: string; count: number }[] = [];
  for (const t of PG_DOCO_TABLES_WITH_LIFECYCLE) {
    const r = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${t} WHERE doco_id = $1`,
      [docoId],
    );
    const n = Number(r.rows[0]?.n ?? 0);
    if (n > 0) {
      nodeTypeCounts.push({ value: TABLE_TO_NODE_TYPE[t] ?? t, count: n });
    }
  }
  nodeTypeCounts.sort((a, b) => b.count - a.count);

  const scopeRows = (
    await c.query<{ name: string; raw_yaml: string | null; n: string }>(
      `SELECT s.name AS name, s.raw_yaml AS raw_yaml, COUNT(e.from_id)::text AS n
         FROM scopes s
         LEFT JOIN edges e
           ON e.to_id = s.id
          AND e.edge_type = 'in_scope_of'
          AND e.from_node_type != 'scope'
          AND e.doco_id = s.doco_id
        WHERE s.doco_id = $1
        GROUP BY s.name, s.raw_yaml
        ORDER BY COUNT(e.from_id) DESC, s.name ASC`,
      [docoId],
    )
  ).rows;

  return {
    lifecycle: Array.from(lifecycleCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => {
        if (a.value === "active") return -1;
        if (b.value === "active") return 1;
        return a.value.localeCompare(b.value);
      }),
    nodeType: nodeTypeCounts,
    scope: scopeRows.map((r: { name: string; raw_yaml: string | null; n: string }) => ({
      name: r.name,
      count: Number(r.n),
      icon: scopeIconFromRawYaml(r.raw_yaml),
    })),
  };
}

function scopeIconFromRawYaml(rawYaml: string | null): string | null {
  if (!rawYaml) return null;
  try {
    const parsed = parseYaml(rawYaml) as { icon?: unknown } | null;
    return typeof parsed?.icon === "string" && parsed.icon.trim() ? parsed.icon : null;
  } catch {
    return null;
  }
}
