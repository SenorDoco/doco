// Pull requests perspective — server-side data access.
//
// A Doco's imported GitHub pull requests are stored as `reference` nodes
// (ref_type "url", locator = the canonical PR URL, prose = the PR title; the
// body lives in attributes.body_md — see github-pr-import.server.ts). This
// perspective reads the latest of those
// References back as a flat, newest-first list — every stage (Merged / Open /
// Closed) shown together, NOT grouped by lifecycle.
//
// When the Doco has no GitHub connection configured, the route renders an
// empty state prompting the user to finish the integration — so this loader
// reports `connected` alongside the items (read-only via the github-connection
// helper; no write surface here).

import { getDocoConnectionsContext } from "./github-connection.server";
import { PR_LIFECYCLE_ORDER, pullRequestLabel } from "./pull-requests";

// Re-exported so existing importers of the label from this module keep working;
// the canonical definition now lives in the client-safe `./pull-requests`.
export { pullRequestLabel } from "./pull-requests";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** Raw `nodes` row for a PR-shaped Reference. */
export interface PullRequestRefRow {
  id: string;
  /** The Reference prose — the PR title (single line; the body lives in
   *  attributes.body_md). */
  reference: string | null;
  /** Promoted `locator` column — the canonical PR URL. */
  locator: string | null;
  /** Canonical lifecycle stage (queued/active/retired); null defaults to queued. */
  lifecycle: string | null;
  /** Last time the imported PR Reference changed in Doco. */
  updated_at: string | null;
}

export interface PullRequestItem {
  id: string;
  title: string;
  url: string;
  lifecycle: string;
  /** Human stage label for the chip (Merged / Open / Closed). Precomputed
   *  server-side so the client component needn't import from this `.server`
   *  module at runtime. */
  label: string;
  updatedAt: string | null;
}

export interface PullRequestsPerspectiveData {
  /** True when the Doco has at least one GitHub connection configured. */
  connected: boolean;
  /**
   * The latest PRs, newest first, across ALL lifecycles — a flat list, not
   * grouped by stage. Capped at the page limit; `totalCount` is the full count.
   */
  items: PullRequestItem[];
  /** Number of PR rows serialized into this response. */
  loadedCount: number;
  /**
   * TRUE total of PR-shaped reference nodes for this Doco, across ALL
   * lifecycles (Merged + Open + Closed). This is the count the header reports.
   */
  totalCount: number;
  /** True when the response is a bounded slice (`totalCount > loadedCount`). */
  hasMore: boolean;
}

/** Internal: a slice row plus the scalar-subquery total (pg bigint → string). */
type PullRequestRefRowWithTotal = PullRequestRefRow & {
  total_count: number | string | null;
};

const DEFAULT_PULL_REQUEST_LIMIT = 500;

// The canonical PR lifecycle stages, as a set, for normalizing row values.
const VALID_PR_LIFECYCLES: ReadonlySet<string> = new Set(PR_LIFECYCLE_ORDER);

/**
 * SQL predicate (including the leading ` AND (...)`) that narrows the PR rows
 * to the requested lifecycle stages, or `""` for no narrowing. `stages` is a
 * whitelisted subset of `PR_LIFECYCLE_ORDER`, so the literals are safe to
 * inline — no bound parameter is needed.
 *
 * `Open` (queued) is the catch-all: any row that is not Merged (`active`) or
 * Closed (`retired`) displays as Open, so it matches `lifecycle NOT IN
 * ('active','retired')` — keeping the filter consistent with the row labels
 * even for off-canonical stages.
 */
function prLifecycleFilterSql(stages: readonly string[]): string {
  const clauses: string[] = [];
  for (const stage of stages) {
    if (stage === "queued") clauses.push("lifecycle NOT IN ('active', 'retired')");
    else if (stage === "active") clauses.push("lifecycle = 'active'");
    else if (stage === "retired") clauses.push("lifecycle = 'retired'");
  }
  return clauses.length > 0 ? ` AND (${clauses.join(" OR ")})` : "";
}

/**
 * Map PR-shaped Reference rows to a flat list of items, preserving input order
 * (newest first from the query) regardless of stage. The PR title is the
 * Reference prose (now the title only — the body lives in attributes.body_md),
 * falling back to the locator (PR URL) when the prose is empty. An unknown/null
 * lifecycle is normalized to `queued`. Pure.
 */
export function pullRequestItemsFromRows(rows: PullRequestRefRow[]): PullRequestItem[] {
  return rows.map((row) => {
    const url = row.locator ?? "";
    const lifecycle =
      row.lifecycle && VALID_PR_LIFECYCLES.has(row.lifecycle) ? row.lifecycle : "queued";
    return {
      id: row.id,
      title: (row.reference ?? "").trim() || url,
      url,
      lifecycle,
      label: pullRequestLabel(lifecycle),
      updatedAt: row.updated_at,
    };
  });
}

/**
 * Load the Pull requests perspective for a Doco: its GitHub connection status
 * plus the latest imported PR References as a flat, newest-first list. PR
 * References are `reference` nodes whose promoted `locator` is a GitHub PR URL
 * (`…/pull/<n>`); the locator column is indexed, so the LIKE stays cheap.
 *
 * `lifecycles` narrows the list (and the reported total) to the given PR
 * stages — a subset of `PR_LIFECYCLE_ORDER`. The narrowing is applied
 * server-side so it spans the whole repo, not just the latest-N slice the page
 * caps at. Omit it (or pass every stage) for the full, unfiltered list; pass an
 * empty array to select nothing.
 */
export async function loadPullRequestsPerspective(
  c: QueryClient,
  docoId: string,
  opts: { limit?: number; lifecycles?: string[] } = {},
): Promise<PullRequestsPerspectiveData> {
  const connectionCtx = await getDocoConnectionsContext(docoId);
  const connected = (connectionCtx?.connections.length ?? 0) > 0;
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_PULL_REQUEST_LIMIT));
  const queryLimit = limit + 1;

  // Normalize the requested stages: undefined → all (no filter); a whitelisted
  // subset → filter; every stage → all (no filter); none → nothing matches, so
  // skip the round-trip entirely.
  const requested =
    opts.lifecycles === undefined
      ? null
      : PR_LIFECYCLE_ORDER.filter((stage) => opts.lifecycles?.includes(stage));
  if (requested && requested.length === 0) {
    return { connected, items: [], loadedCount: 0, totalCount: 0, hasMore: false };
  }
  const filterSql =
    requested && requested.length < PR_LIFECYCLE_ORDER.length
      ? prLifecycleFilterSql(requested)
      : "";

  // The true total comes from an uncorrelated scalar subquery (same predicate,
  // no LIMIT), computed once as an InitPlan. COUNT(*) OVER() proved unreliable
  // under LIMIT on the production planner — it returned the page limit, not the
  // full count — and a result-row cap truncates windowed counts; a plain
  // aggregate subquery is immune to both, on one round-trip. The lifecycle
  // filter rides on both the slice and the count so the total tracks the filter.
  const { rows } = await c.query<PullRequestRefRowWithTotal>(
    `SELECT id,
            prose AS reference,
            attributes->>'locator' AS locator,
            lifecycle,
            updated_at::text AS updated_at,
            (SELECT COUNT(*)
               FROM nodes
              WHERE doco_id = $1
                AND node_type = 'reference'
                AND attributes->>'locator' LIKE '%/pull/%'${filterSql}) AS total_count
       FROM nodes
      WHERE doco_id = $1
        AND node_type = 'reference'
        AND attributes->>'locator' LIKE '%/pull/%'${filterSql}
      ORDER BY updated_at DESC, created_at DESC, id ASC
      LIMIT $2`,
    [docoId, queryLimit],
  );
  const totalCount = Number(rows[0]?.total_count ?? 0);
  const visibleRows = rows.length > limit ? rows.slice(0, limit) : rows;
  const loadedCount = visibleRows.length;

  return {
    connected,
    items: pullRequestItemsFromRows(visibleRows),
    loadedCount,
    totalCount,
    hasMore: totalCount > loadedCount,
  };
}
