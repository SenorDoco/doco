// Pull requests perspective — server-side data access.
//
// A Doco's imported GitHub pull requests are stored as `reference` nodes
// (ref_type "url", locator = the canonical PR URL, prose = title + body —
// see github-pr-import.server.ts). This perspective reads the latest of those
// References back as a flat, newest-first list — every stage (Merged / Open /
// Closed) shown together, NOT grouped by lifecycle.
//
// When the Doco has no GitHub connection configured, the route renders an
// empty state prompting the user to finish the integration — so this loader
// reports `connected` alongside the items (read-only via the github-connection
// helper; no write surface here).

import { getDocoConnectionsContext } from "./github-connection.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** Raw `nodes` row for a PR-shaped Reference. */
export interface PullRequestRefRow {
  id: string;
  /** The Reference prose: first line = PR title, rest = body. */
  reference: string | null;
  /** Promoted `locator` column — the canonical PR URL. */
  locator: string | null;
  /** Canonical lifecycle stage (drafting/asserted/retired); null defaults to drafting. */
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

// Human labels for the PR lifecycle stages, shown as a per-row chip.
const LIFECYCLE_LABELS: Record<string, string> = {
  asserted: "Merged",
  drafting: "Open",
  retired: "Closed",
};
const DEFAULT_PULL_REQUEST_LIMIT = 500;

/** Display label for a PR's lifecycle chip (Merged / Open / Closed). */
export function pullRequestLabel(lifecycle: string): string {
  return LIFECYCLE_LABELS[lifecycle] ?? LIFECYCLE_LABELS.drafting;
}

function firstLine(value: string | null | undefined): string {
  return String(value ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
}

/**
 * Map PR-shaped Reference rows to a flat list of items, preserving input order
 * (newest first from the query) regardless of stage. The PR title is the first
 * line of the Reference prose, falling back to the locator (PR URL) when the
 * prose is empty. An unknown/null lifecycle is normalized to `drafting`. Pure.
 */
export function pullRequestItemsFromRows(rows: PullRequestRefRow[]): PullRequestItem[] {
  return rows.map((row) => {
    const url = row.locator ?? "";
    const lifecycle = row.lifecycle && LIFECYCLE_LABELS[row.lifecycle] ? row.lifecycle : "drafting";
    return {
      id: row.id,
      title: firstLine(row.reference) || url,
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
 */
export async function loadPullRequestsPerspective(
  c: QueryClient,
  docoId: string,
  opts: { limit?: number } = {},
): Promise<PullRequestsPerspectiveData> {
  const connectionCtx = await getDocoConnectionsContext(docoId);
  const connected = (connectionCtx?.connections.length ?? 0) > 0;
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_PULL_REQUEST_LIMIT));
  const queryLimit = limit + 1;

  // The true total comes from an uncorrelated scalar subquery (same predicate,
  // no LIMIT), computed once as an InitPlan. COUNT(*) OVER() proved unreliable
  // under LIMIT on the production planner — it returned the page limit, not the
  // full count — and a result-row cap truncates windowed counts; a plain
  // aggregate subquery is immune to both, on one round-trip.
  const { rows } = await c.query<PullRequestRefRowWithTotal>(
    `SELECT id,
            prose AS reference,
            locator,
            lifecycle,
            updated_at::text AS updated_at,
            (SELECT COUNT(*)
               FROM nodes
              WHERE doco_id = $1
                AND node_type = 'reference'
                AND locator LIKE '%/pull/%') AS total_count
       FROM nodes
      WHERE doco_id = $1
        AND node_type = 'reference'
        AND locator LIKE '%/pull/%'
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
