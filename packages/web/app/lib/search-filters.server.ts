// Shared filter logic for /search.json and /search HTML page. Both
// surfaces accept the same `lifecycle` / `entity_type` filters applied
// BEFORE the cosine top-N slice.
import type { PoolClient } from "pg";

/**
 * Parsed filter spec. `null` for a field means "no filter" (everything
 * passes). `lifecycle: null` is the special "wildcard" state — see
 * parseSearchFilters.
 */
export interface SearchFilters {
  /** Allowed lifecycle values. `null` = no filter (all values). */
  lifecycle: string[] | null;
  /** Allowed neuron types. `null` = no filter (all types). */
  entityType: string[] | null;
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

  const nodeTypeVals = readMulti(params, "entity_type");
  let entityType: string[] | null;
  if (nodeTypeVals === null) {
    entityType = facets.entityType.map((f) => f.value);
  } else if (nodeTypeVals.length === 1 && nodeTypeVals[0] === "*") {
    entityType = null;
  } else {
    entityType = nodeTypeVals;
  }

  return { lifecycle, entityType, limit };
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
 * Doco-scoped note tables (PG plural names). Each carries a
 * `lifecycle` column directly. principals + organizations are
 * host-level, so they don't filter on doco_id.
 *
 * Primitives (`guidance_primitives`, `neuron_authoring_primitives`)
 * are not neurons — they are constitution metadata with their own
 * surface (/<handle>/constitution and /<handle>/api/primitives.json)
 * and are intentionally absent here. Anything iterating "neurons of
 * a Doco" must use this list, never a list that includes primitive
 * tables.
 */
const PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE = [
  "intents",
  "ideas",
  "rules",
  "decisions",
  "actions",
  "logs",
  "evals",
  "reference_entities",
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): State neuron type.
  "states",
] as const;

/**
 * Map from external entity_type (singular) → PG table (plural).
 * Primitives (`guidance_primitive`, `neuron_authoring_primitive`) are
 * not neurons and are intentionally omitted — they are reachable
 * only via /<handle>/api/primitives.json and the constitution
 * surface.
 */
const NEURON_TYPE_TO_TABLE: Record<string, string> = {
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "reference_entities",
  state: "states",
  principal: "principals",
  organization: "organizations",
};

/** Inverse: PG table → external entity_type used on the wire. */
const TABLE_TO_NODE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(NEURON_TYPE_TO_TABLE).map(([nt, tbl]) => [tbl, nt]),
);

export async function resolveFilteredCandidates(
  c: PoolClient,
  docoId: string,
  filters: SearchFilters,
): Promise<Set<string> | null> {
  if (filters.lifecycle === null && filters.entityType === null) {
    return null;
  }

  let lifecycleIds: Set<string> | null = null;
  if (filters.lifecycle !== null) {
    lifecycleIds = new Set();
    // Notes only — primitives are not neurons and never participate in
    // neuron search results, even when their lifecycle matches.
    for (const t of PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE) {
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
  if (filters.entityType !== null) {
    nodeTypeIds = new Set();
    for (const nt of filters.entityType) {
      const table = NEURON_TYPE_TO_TABLE[nt];
      if (!table) continue;
      if (table === "principals" || table === "organizations") continue;
      const r = await c.query<{ id: string }>(`SELECT id FROM ${table} WHERE doco_id = $1`, [
        docoId,
      ]);
      for (const row of r.rows) nodeTypeIds.add(row.id);
    }
  }

  const sets = [lifecycleIds, nodeTypeIds].filter((s): s is Set<string> => s !== null);
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
  lifecycle: { value: string; count: number; updatedAt: string | null }[];
  entityType: {
    value: string;
    count: number;
    activeCount?: number;
    updatedAt: string | null;
  }[];
}


export async function computeFilterFacets(c: PoolClient, docoId: string): Promise<FilterFacets> {
  // Facets describe the *notes* of a Doco. Primitives (constitution
  // metadata) are intentionally excluded — they have their own
  // surface and counting them as neurons makes a Doco with only a
  // template constitution misread as having captured work.
  const lifecycleFacets = new Map<string, { count: number; updatedAt: string | null }>();
  for (const t of PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE) {
    const r = await c.query<{ value: string; n: string; updated_at: Date | string | null }>(
      `SELECT COALESCE(lifecycle, 'active') AS value,
              COUNT(*)::text AS n,
              MAX(updated_at) AS updated_at
         FROM ${t}
        WHERE doco_id = $1
        GROUP BY value`,
      [docoId],
    );
    for (const row of r.rows) {
      const n = Number(row.n);
      const current = lifecycleFacets.get(row.value) ?? { count: 0, updatedAt: null };
      lifecycleFacets.set(row.value, {
        count: current.count + n,
        updatedAt: latestIso(current.updatedAt, toIso(row.updated_at)),
      });
    }
  }

  const nodeTypeCounts: {
    value: string;
    count: number;
    activeCount: number;
    updatedAt: string | null;
  }[] = [];
  for (const t of PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE) {
    const r = await c.query<{
      n: string;
      active_n: string;
      updated_at: Date | string | null;
    }>(
      `SELECT COUNT(*)::text AS n,
              (COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'active'))::text AS active_n,
              MAX(updated_at) AS updated_at
         FROM ${t} WHERE doco_id = $1`,
      [docoId],
    );
    const row = r.rows[0];
    const n = Number(row?.n ?? 0);
    if (n > 0) {
      nodeTypeCounts.push({
        value: TABLE_TO_NODE_TYPE[t] ?? t,
        count: n,
        activeCount: Number(row?.active_n ?? 0),
        updatedAt: toIso(row?.updated_at),
      });
    }
  }
  nodeTypeCounts.sort((a, b) => b.count - a.count);

  return {
    lifecycle: Array.from(lifecycleFacets.entries())
      .map(([value, facet]) => ({ value, count: facet.count, updatedAt: facet.updatedAt }))
      .sort((a, b) => {
        if (a.value === "active") return -1;
        if (b.value === "active") return 1;
        return a.value.localeCompare(b.value);
      }),
    entityType: nodeTypeCounts,
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
