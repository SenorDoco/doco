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
 * Other values are treated as current and surface in default search results.
 */
export const HIDDEN_BY_DEFAULT_LIFECYCLE_VALUES = ["retired"] as const;

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

  const entityTypeVals = readMulti(params, "entity_type");
  let entityType: string[] | null;
  if (entityTypeVals === null) {
    entityType = facets.entityType.map((f) => f.value);
  } else if (entityTypeVals.length === 1 && entityTypeVals[0] === "*") {
    entityType = null;
  } else {
    entityType = entityTypeVals;
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
 * Doco-scoped neuron tables (PG plural names). Each carries a
 * `lifecycle` column directly and a typed `doco_id` column.
 *
 * Policies (`guidance_policies`, `neuron_authoring_policies`)
 * are not neurons — they are Doco-level metadata with their own
 * surface (/<handle>/policies and /<handle>/api/policies.json)
 * and are intentionally absent here. Anything iterating "neurons of
 * a Doco" must use this list, never a list that includes policy
 * tables.
 */
interface DocoNeuronTableFilterSpec {
  table: string;
  entityType: string;
  docoWhereSql: string;
}

const PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE: DocoNeuronTableFilterSpec[] = [
  { table: "intents", entityType: "intent", docoWhereSql: "doco_id = $1" },
  { table: "ideas", entityType: "idea", docoWhereSql: "doco_id = $1" },
  { table: "rules", entityType: "rule", docoWhereSql: "doco_id = $1" },
  { table: "decisions", entityType: "decision", docoWhereSql: "doco_id = $1" },
  { table: "actions", entityType: "action", docoWhereSql: "doco_id = $1" },
  { table: "logs", entityType: "log", docoWhereSql: "doco_id = $1" },
  { table: "evals", entityType: "eval", docoWhereSql: "doco_id = $1" },
  { table: "reference_entities", entityType: "reference", docoWhereSql: "doco_id = $1" },
  { table: "states", entityType: "state", docoWhereSql: "doco_id = $1" },
  { table: "principals", entityType: "principal", docoWhereSql: "doco_id = $1" },
];

/**
 * Map from external entity_type (singular) → PG table (plural).
 * Policies (`guidance_policy`, `neuron_authoring_policy`) are
 * not neurons and are intentionally omitted — they are reachable
 * only via /<handle>/api/policies.json and the policies
 * surface.
 */
const NEURON_TYPE_TO_TABLE: Record<string, DocoNeuronTableFilterSpec | null> = {
  intent: { table: "intents", entityType: "intent", docoWhereSql: "doco_id = $1" },
  idea: { table: "ideas", entityType: "idea", docoWhereSql: "doco_id = $1" },
  rule: { table: "rules", entityType: "rule", docoWhereSql: "doco_id = $1" },
  decision: { table: "decisions", entityType: "decision", docoWhereSql: "doco_id = $1" },
  action: { table: "actions", entityType: "action", docoWhereSql: "doco_id = $1" },
  log: { table: "logs", entityType: "log", docoWhereSql: "doco_id = $1" },
  eval: { table: "evals", entityType: "eval", docoWhereSql: "doco_id = $1" },
  reference: {
    table: "reference_entities",
    entityType: "reference",
    docoWhereSql: "doco_id = $1",
  },
  state: { table: "states", entityType: "state", docoWhereSql: "doco_id = $1" },
  principal: {
    table: "principals",
    entityType: "principal",
    docoWhereSql: "doco_id = $1",
  },
  organization: null,
};

/** Inverse: PG table → external entity_type used on the wire. */
const TABLE_TO_ENTITY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(NEURON_TYPE_TO_TABLE)
    .filter((entry): entry is [string, DocoNeuronTableFilterSpec] => entry[1] !== null)
    .map(([nt, spec]) => [spec.table, nt]),
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
    // Notes only — policies are not neurons and never participate in
    // neuron search results, even when their lifecycle matches.
    for (const spec of PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE) {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${spec.table}
          WHERE ${spec.docoWhereSql}
            AND COALESCE(lifecycle, 'active') = ANY($2::text[])`,
        [docoId, filters.lifecycle],
      );
      for (const row of r.rows) lifecycleIds.add(row.id);
    }
  }

  let entityTypeIds: Set<string> | null = null;
  if (filters.entityType !== null) {
    entityTypeIds = new Set();
    for (const nt of filters.entityType) {
      const spec = NEURON_TYPE_TO_TABLE[nt];
      if (!spec) continue;
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${spec.table} WHERE ${spec.docoWhereSql}`,
        [docoId],
      );
      for (const row of r.rows) entityTypeIds.add(row.id);
    }
  }

  const sets = [lifecycleIds, entityTypeIds].filter((s): s is Set<string> => s !== null);
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
  // Facets describe the neuron records of a Doco. Policies are
  // intentionally excluded — they have their own
  // surface and counting them as neurons makes a Doco with only a
  // template policies misread as having captured work. Principals
  // are included because role-personas are first-class neurons.
  const lifecycleFacets = new Map<string, { count: number; updatedAt: string | null }>();
  for (const spec of PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE) {
    const r = await c.query<{ value: string; n: string; updated_at: Date | string | null }>(
      `SELECT COALESCE(lifecycle, 'active') AS value,
              COUNT(*)::text AS n,
              MAX(updated_at) AS updated_at
         FROM ${spec.table}
        WHERE ${spec.docoWhereSql}
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

  const entityTypeCounts: {
    value: string;
    count: number;
    activeCount: number;
    updatedAt: string | null;
  }[] = [];
  for (const spec of PG_DOCO_NOTE_TABLES_WITH_LIFECYCLE) {
    const r = await c.query<{
      n: string;
      active_n: string;
      updated_at: Date | string | null;
    }>(
      `SELECT COUNT(*)::text AS n,
              (COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'active'))::text AS active_n,
              MAX(updated_at) AS updated_at
         FROM ${spec.table} WHERE ${spec.docoWhereSql}`,
      [docoId],
    );
    const row = r.rows[0];
    const n = Number(row?.n ?? 0);
    if (n > 0) {
      entityTypeCounts.push({
        value: TABLE_TO_ENTITY_TYPE[spec.table] ?? spec.entityType,
        count: n,
        activeCount: Number(row?.active_n ?? 0),
        updatedAt: toIso(row?.updated_at),
      });
    }
  }
  entityTypeCounts.sort((a, b) => b.count - a.count);

  return {
    lifecycle: Array.from(lifecycleFacets.entries())
      .map(([value, facet]) => ({ value, count: facet.count, updatedAt: facet.updatedAt }))
      .sort((a, b) => {
        if (a.value === "active") return -1;
        if (b.value === "active") return 1;
        return a.value.localeCompare(b.value);
      }),
    entityType: entityTypeCounts,
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
