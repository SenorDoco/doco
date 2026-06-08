// Per-lifecycle domain totals for a perspective headline.
//
// A perspective headline counts only the lifecycles its canvas shows (retired
// hides by default), so it needs the TRUE per-stage totals of its domain —
// counted server-side, immune to the slice cap that truncates the returned
// rows. The client sums the visible stages with `visibleLifecycleTotal`
// (perspective-count.ts).

import { EMPTY_LIFECYCLE_COUNTS, type LifecycleCounts } from "./node-colors";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const STAGES: ReadonlySet<string> = new Set<keyof LifecycleCounts>([
  "drafting",
  "queued",
  "active",
  "retired",
]);

/**
 * Fold `{ lifecycle, n }` aggregate rows into a {@link LifecycleCounts}.
 * Stages outside the canonical four are ignored. Exported for loaders whose
 * domain predicate is too specific for {@link loadNodeLifecycleTotals} and that
 * group their own query (e.g. the overview graph's principal-active rule).
 */
export function tallyLifecycleRows(
  rows: readonly { lifecycle: string; n: string | number }[],
): LifecycleCounts {
  const out: LifecycleCounts = { ...EMPTY_LIFECYCLE_COUNTS };
  for (const row of rows) {
    if (STAGES.has(row.lifecycle)) out[row.lifecycle as keyof LifecycleCounts] += Number(row.n);
  }
  return out;
}

/**
 * TRUE per-lifecycle totals of a Doco's nodes of the given types — counted
 * before any slice cap, so the headline's total stays honest even when the
 * returned rows are truncated. The single source of truth for every
 * node-type-scoped perspective domain (steps, principals, references, rules).
 */
export async function loadNodeLifecycleTotals(
  c: QueryClient,
  docoId: string,
  nodeTypes: readonly string[],
): Promise<LifecycleCounts> {
  if (nodeTypes.length === 0) return { ...EMPTY_LIFECYCLE_COUNTS };
  const rows = (
    await c.query<{ lifecycle: string; n: string }>(
      `SELECT COALESCE(lifecycle, 'active') AS lifecycle, COUNT(*)::text AS n
         FROM nodes
        WHERE doco_id = $1 AND node_type = ANY($2::text[])
        GROUP BY 1`,
      [docoId, nodeTypes],
    )
  ).rows;
  return tallyLifecycleRows(rows);
}
