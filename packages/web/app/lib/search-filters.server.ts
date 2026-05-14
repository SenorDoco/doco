// Shared filter logic for /search.json and /search HTML page. Both
// surfaces accept the same `lifecycle` / `node_type` / `scope` filters
// applied BEFORE the cosine top-N slice. See the Decision
// `what-shape-do-the-search-filters-take-and-how-do-defaults`.
import type { Database } from "better-sqlite3";

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
 * Lifecycle values that signal the entity is retired and should be
 * hidden by default. Other values (active, succeeded, accepted, …) are
 * treated as "current" and surface in default search results.
 */
export const RETIRED_LIFECYCLE_VALUES = [
  "succeeded",
  "superseded",
  "abandoned",
  "failed",
] as const;

/**
 * Read filter params from a query string. The conventions:
 *
 * - `lifecycle`: when ABSENT, defaults to "every facet value except the
 *   retired set" (hide deprecated/superseded/rejected/abandoned). When
 *   the param is present with a comma-separated list, that's the exact
 *   include set. Pass `*` to disable the filter entirely (returns null).
 * - `node_type`: absent → null (no filter). Otherwise comma-separated.
 * - `scope`: absent → null (no filter). Otherwise comma-separated names.
 * - `limit`: clamped to [1, 500]; defaults to 100.
 *
 * `facets` is required so the lifecycle default adapts to whatever
 * lifecycle values are actually present on the Doco — instead of
 * hard-coding e.g. `active` (which misses Actions whose lifecycle is
 * `succeeded`, etc.).
 */
export function parseSearchFilters(
  params: URLSearchParams,
  facets: FilterFacets,
): SearchFilters {
  const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, rawLimit))
    : DEFAULT_LIMIT;

  const lifecycleVals = readMulti(params, "lifecycle");
  let lifecycle: string[] | null;
  if (lifecycleVals === null) {
    // Default: every known lifecycle value except the retired set.
    const retired = new Set<string>(RETIRED_LIFECYCLE_VALUES);
    lifecycle = facets.lifecycle.map((f) => f.value).filter((v) => !retired.has(v));
  } else if (lifecycleVals.length === 1 && lifecycleVals[0] === "*") {
    lifecycle = null;
  } else {
    lifecycle = lifecycleVals;
    // Empty / all-unchecked: honour as "include nothing" (no results).
  }

  // Type and scope default to "every value" so the sidebar renders with
  // all checkboxes checked. Semantically equivalent to "no filter" (every
  // entity passes); visually clear that nothing is being excluded.
  // Pass `*` to keep the filter wide-open without listing every value.
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

/**
 * Read a filter param that may appear repeated in the URL (HTML
 * checkbox forms) and/or comma-separated in a single occurrence
 * (compact /search.json calls). Returns:
 *   - `null` when the key is absent entirely (caller applies default).
 *   - `string[]` of distinct trimmed values otherwise. May be empty if
 *     the caller passed `?key=` with no value (intentional empty set).
 */
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

/** Tables that carry an entity-shaped row and a `lifecycle` column. */
const LIFECYCLE_TABLES = [
  "principal",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "reasoning",
  "eval",
  "reference",
  "organization",
] as const;

/**
 * Tables that don't have a `lifecycle` column today — `scope` stores
 * its lifecycle in the YAML and we read it back via `json_extract`.
 * (Per the recent scope-deprecation feature.)
 */
const LIFECYCLE_VIA_JSON_TABLES = ["scope"] as const;

const ALL_LIFECYCLE_TABLES = [...LIFECYCLE_TABLES, ...LIFECYCLE_VIA_JSON_TABLES];

/**
 * Compute the set of entity ids that satisfy every filter. Returns
 * `null` when no filters are applied — caller treats that as "every
 * entity passes."
 *
 * Filtering happens at SQL time, BEFORE we touch the embeddings table,
 * so we don't pay cosine cost on entities the user already excluded.
 */
export function resolveFilteredCandidates(
  db: Database,
  filters: SearchFilters,
): Set<string> | null {
  // Fast path: no filters at all.
  if (filters.lifecycle === null && filters.nodeType === null && filters.scope === null) {
    return null;
  }

  // Lifecycle filter — compute the set of ids whose lifecycle matches.
  // (Plus the typeless principals etc. that we still want to include.)
  let lifecycleIds: Set<string> | null = null;
  if (filters.lifecycle !== null) {
    lifecycleIds = new Set();
    const lcPlaceholders = filters.lifecycle.map(() => "?").join(",");
    for (const t of LIFECYCLE_TABLES) {
      // If the table has a `lifecycle` column, filter on it directly;
      // treat NULL as "active" (back-compat with rows authored before
      // lifecycle was conventional).
      const rows = db
        .prepare(
          `SELECT id FROM ${t} WHERE COALESCE(lifecycle, 'active') IN (${lcPlaceholders})`,
        )
        .all(...filters.lifecycle) as { id: string }[];
      for (const r of rows) lifecycleIds.add(r.id);
    }
    for (const t of LIFECYCLE_VIA_JSON_TABLES) {
      const rows = db
        .prepare(
          `SELECT id FROM ${t} WHERE COALESCE(json_extract(raw_json, '$.lifecycle'), 'active') IN (${lcPlaceholders})`,
        )
        .all(...filters.lifecycle) as { id: string }[];
      for (const r of rows) lifecycleIds.add(r.id);
    }
  }

  // Node-type filter — match against the entity_id prefix.
  let nodeTypeIds: Set<string> | null = null;
  if (filters.nodeType !== null) {
    nodeTypeIds = new Set();
    for (const nt of filters.nodeType) {
      const table = ALL_LIFECYCLE_TABLES.find((t) => t === nt);
      if (!table) continue; // unknown type — silently ignore
      const rows = db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[];
      for (const r of rows) nodeTypeIds.add(r.id);
    }
  }

  // Scope filter — resolve scope names → ids, then walk the in_scope_of
  // edges to find entities tagged with any of them.
  let scopeIds: Set<string> | null = null;
  if (filters.scope !== null) {
    scopeIds = new Set();
    const namePlaceholders = filters.scope.map(() => "?").join(",");
    const scopeRows = db
      .prepare(`SELECT id FROM scope WHERE name IN (${namePlaceholders})`)
      .all(...filters.scope) as { id: string }[];
    if (scopeRows.length > 0) {
      const idPlaceholders = scopeRows.map(() => "?").join(",");
      const edgeRows = db
        .prepare(
          `SELECT from_id FROM edges
           WHERE edge_type = 'in_scope_of' AND to_id IN (${idPlaceholders})`,
        )
        .all(...scopeRows.map((r) => r.id)) as { from_id: string }[];
      for (const r of edgeRows) scopeIds.add(r.from_id);
    }
  }

  // Intersect every non-null set.
  const sets = [lifecycleIds, nodeTypeIds, scopeIds].filter(
    (s): s is Set<string> => s !== null,
  );
  if (sets.length === 0) return null;
  if (sets.length === 1) return sets[0];

  // Start with the smallest set so the loop is cheap.
  sets.sort((a, b) => a.size - b.size);
  const out = new Set<string>();
  for (const id of sets[0]) {
    if (sets.slice(1).every((s) => s.has(id))) out.add(id);
  }
  return out;
}

/**
 * Distinct values present on disk for each filter axis — used to
 * populate the sidebar checkbox options. Counts let the UI show
 * (N) next to each value.
 */
export interface FilterFacets {
  lifecycle: { value: string; count: number }[];
  nodeType: { value: string; count: number }[];
  scope: { name: string; count: number }[];
}

export function computeFilterFacets(db: Database): FilterFacets {
  // Lifecycle counts — union across every table that has the column.
  const lifecycleCounts = new Map<string, number>();
  for (const t of LIFECYCLE_TABLES) {
    const rows = db
      .prepare(
        `SELECT COALESCE(lifecycle, 'active') AS value, COUNT(*) AS n FROM ${t} GROUP BY value`,
      )
      .all() as { value: string; n: number }[];
    for (const r of rows) {
      lifecycleCounts.set(r.value, (lifecycleCounts.get(r.value) ?? 0) + r.n);
    }
  }
  for (const t of LIFECYCLE_VIA_JSON_TABLES) {
    const rows = db
      .prepare(
        `SELECT COALESCE(json_extract(raw_json, '$.lifecycle'), 'active') AS value, COUNT(*) AS n
         FROM ${t} GROUP BY value`,
      )
      .all() as { value: string; n: number }[];
    for (const r of rows) {
      lifecycleCounts.set(r.value, (lifecycleCounts.get(r.value) ?? 0) + r.n);
    }
  }

  // Node-type counts — one row per type.
  const nodeTypeCounts: { value: string; count: number }[] = [];
  for (const t of ALL_LIFECYCLE_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    if (row.n > 0) nodeTypeCounts.push({ value: t, count: row.n });
  }
  nodeTypeCounts.sort((a, b) => b.count - a.count);

  // Scope counts — distinct scope names with at least one in_scope_of edge.
  const scopeRows = db
    .prepare(
      `SELECT s.name AS name, COUNT(e.from_id) AS n
       FROM scope s
       LEFT JOIN edges e
         ON e.to_id = s.id AND e.edge_type = 'in_scope_of' AND e.from_node_type != 'scope'
       GROUP BY s.name
       ORDER BY n DESC, s.name ASC`,
    )
    .all() as { name: string; n: number }[];

  return {
    lifecycle: Array.from(lifecycleCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => {
        // `active` first, then alphabetical.
        if (a.value === "active") return -1;
        if (b.value === "active") return 1;
        return a.value.localeCompare(b.value);
      }),
    nodeType: nodeTypeCounts,
    scope: scopeRows.map((r) => ({ name: r.name, count: r.n })),
  };
}
