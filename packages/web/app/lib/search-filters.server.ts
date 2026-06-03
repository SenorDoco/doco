// Shared filter logic for /search.json and /search HTML page. Both
// surfaces accept the same `lifecycle` / `entity_type` filters applied
// BEFORE the cosine top-N slice.
import { NODE_TYPES } from "@doco/shared";
import type { PoolClient } from "pg";
import type { LifecycleCounts } from "./node-colors";

/**
 * Parsed filter spec. `null` for a field means "no filter" (everything
 * passes). `lifecycle: null` is the special "wildcard" state — see
 * parseSearchFilters.
 */
export interface SearchFilters {
  /** Allowed lifecycle values. `null` = no filter (all values). */
  lifecycle: string[] | null;
  /** Allowed node types. `null` = no filter (all types). */
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

const SEARCHABLE_NODE_TYPES = [...NODE_TYPES];
const SEARCHABLE_NODE_TYPE_SET = new Set<string>(SEARCHABLE_NODE_TYPES);

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
    // Nodes only — policies are not nodes and never participate in
    // node search results, even when their lifecycle matches.
    for (const entityType of SEARCHABLE_NODE_TYPES) {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM nodes
          WHERE node_type = $3 AND doco_id = $1
            AND COALESCE(lifecycle, 'active') = ANY($2::text[])`,
        [docoId, filters.lifecycle, entityType],
      );
      for (const row of r.rows) lifecycleIds.add(row.id);
    }
  }

  let entityTypeIds: Set<string> | null = null;
  if (filters.entityType !== null) {
    entityTypeIds = new Set();
    for (const nt of filters.entityType) {
      if (!SEARCHABLE_NODE_TYPE_SET.has(nt)) continue;
      const r = await c.query<{ id: string }>(
        "SELECT id FROM nodes WHERE node_type = $2 AND doco_id = $1",
        [docoId, nt],
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
    // Per-lifecycle breakdown (drafting / queued / active / retired) of `count`.
    // `computeFilterFacets` always populates it; the search surface
    // rebuilds hit-scoped counts via `withHitDerivedCounts` and omits it
    // (the search UI shows only the total per type), so it is optional.
    counts?: LifecycleCounts;
    updatedAt: string | null;
  }[];
  edgeType: { value: string; count: number; updatedAt: string | null }[];
}

export async function computeFilterFacets(c: PoolClient, docoId: string): Promise<FilterFacets> {
  // Facets describe the node records of a Doco. Policies are
  // intentionally excluded — they have their own
  // surface and counting them as nodes makes a Doco with only a
  // template policies misread as having captured work. Principals
  // are included because role-personas are first-class nodes.
  const nodeTypes = SEARCHABLE_NODE_TYPES;
  const lifecycleFacets = new Map<string, { count: number; updatedAt: string | null }>();
  const lifecycleRows = (
    await c.query<{
      node_type: string;
      value: string;
      n: string;
      updated_at: Date | string | null;
    }>(
      `SELECT node_type,
              COALESCE(lifecycle, 'active') AS value,
              COUNT(*)::text AS n,
              MAX(updated_at) AS updated_at
         FROM nodes
        WHERE doco_id = $1
          AND node_type = ANY($2::text[])
        GROUP BY node_type, value`,
      [docoId, nodeTypes],
    )
  ).rows;
  for (const row of lifecycleRows) {
    const n = Number(row.n);
    const current = lifecycleFacets.get(row.value) ?? { count: 0, updatedAt: null };
    lifecycleFacets.set(row.value, {
      count: current.count + n,
      updatedAt: latestIso(current.updatedAt, toIso(row.updated_at)),
    });
  }

  const entityTypeCounts: {
    value: string;
    count: number;
    counts: LifecycleCounts;
    updatedAt: string | null;
  }[] = (
    await c.query<{
      node_type: string;
      n: string;
      drafting_n: string;
      queued_n: string;
      active_n: string;
      retired_n: string;
      updated_at: Date | string | null;
    }>(
      `SELECT COUNT(*)::text AS n,
              (COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'drafting'))::text AS drafting_n,
              (COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'queued'))::text AS queued_n,
              (COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'active'))::text AS active_n,
              (COUNT(*) FILTER (WHERE COALESCE(lifecycle, 'active') = 'retired'))::text AS retired_n,
              MAX(updated_at) AS updated_at,
              node_type
         FROM nodes
        WHERE doco_id = $1
          AND node_type = ANY($2::text[])
        GROUP BY node_type
        ORDER BY COUNT(*) DESC, node_type`,
      [docoId, nodeTypes],
    )
  ).rows.map((row) => ({
    value: row.node_type,
    count: Number(row.n),
    counts: {
      drafting: Number(row.drafting_n),
      queued: Number(row.queued_n),
      active: Number(row.active_n),
      retired: Number(row.retired_n),
    },
    updatedAt: toIso(row.updated_at),
  }));
  entityTypeCounts.sort((a, b) => b.count - a.count);

  const edgeTypeCounts = (
    await c.query<{ value: string; n: string; updated_at: Date | string | null }>(
      `SELECT edge_type AS value,
              COUNT(*)::text AS n,
              MAX(updated_at) AS updated_at
         FROM edges
        WHERE doco_id = $1
          AND COALESCE(lifecycle, 'active') <> 'retired'
        GROUP BY edge_type
        ORDER BY COUNT(*) DESC, edge_type`,
      [docoId],
    )
  ).rows.map((row) => ({
    value: row.value,
    count: Number(row.n),
    updatedAt: toIso(row.updated_at),
  }));

  return {
    lifecycle: Array.from(lifecycleFacets.entries())
      .map(([value, facet]) => ({ value, count: facet.count, updatedAt: facet.updatedAt }))
      .sort((a, b) => {
        // Canonical lifecycle progression — render in the same order
        // everywhere so the stats card, the filter row, and the audit
        // panel agree.
        const order = ["drafting", "queued", "active", "retired"];
        const ai = order.indexOf(a.value);
        const bi = order.indexOf(b.value);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.value.localeCompare(b.value);
      }),
    entityType: entityTypeCounts,
    edgeType: edgeTypeCounts,
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
