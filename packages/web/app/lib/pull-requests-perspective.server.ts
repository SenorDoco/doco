// Pull requests perspective — server-side data access.
//
// A Doco's imported GitHub pull requests are stored as `reference` nodes
// (ref_type "url", locator = the canonical PR URL, prose = title + body —
// see github-pr-import.server.ts). This perspective reads those References
// back and groups them by lifecycle:
//   asserted → Merged   (the PR shipped)
//   drafting → Open      (in-flight)
//   retired  → Closed    (closed without merging)
//
// When the Doco has no GitHub connection configured, the route renders an
// empty state prompting the user to finish the integration — so this loader
// reports `connected` alongside the groups (read-only via the github-connection
// helper; no write surface here).

import { getDocoConnectionsContext } from "./github-connection.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** Raw `nodes` row for a PR-shaped Reference (the helper's input). */
export interface PullRequestRefRow {
  id: string;
  /** The Reference prose: first line = PR title, rest = body. */
  reference: string | null;
  /** Promoted `locator` column — the canonical PR URL. */
  locator: string | null;
  /** Canonical lifecycle stage (drafting/asserted/retired); null defaults to drafting. */
  lifecycle: string | null;
}

export interface PullRequestItem {
  id: string;
  title: string;
  url: string;
  lifecycle: string;
}

export interface PullRequestGroup {
  lifecycle: string;
  label: string;
  prs: PullRequestItem[];
}

export interface PullRequestsPerspectiveData {
  /** True when the Doco has at least one GitHub connection configured. */
  connected: boolean;
  /** Non-empty lifecycle groups in display order (Merged → Open → Closed). */
  groups: PullRequestGroup[];
  /** Number of PR rows serialized into this response. */
  loadedCount: number;
  /**
   * TRUE total of PR-shaped reference nodes for this Doco, across ALL
   * lifecycles (Merged + Open + Closed). This is the count the header reports;
   * it is independent of the client-side lifecycle filter, so hiding "Closed"
   * never changes it.
   */
  totalCount: number;
  /** True when the response is a bounded slice (`totalCount > loadedCount`). */
  hasMore: boolean;
}

/** Internal: a slice row plus the windowed total. `COUNT(*) OVER()` is a
 *  bigint, which the pg driver returns as a string, so widen accordingly. */
type PullRequestRefRowWithTotal = PullRequestRefRow & {
  total_count: number | string | null;
};

// Display order + human labels for the three PR lifecycle buckets. Merged
// (the settled, shipped outcome) leads, then Open work in motion, then Closed.
const LIFECYCLE_GROUPS: { lifecycle: string; label: string }[] = [
  { lifecycle: "asserted", label: "Merged" },
  { lifecycle: "drafting", label: "Open" },
  { lifecycle: "retired", label: "Closed" },
];
const DEFAULT_PULL_REQUEST_LIMIT = 500;

function firstLine(value: string | null | undefined): string {
  return String(value ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
}

/**
 * Group PR-shaped Reference rows by lifecycle into the fixed display order
 * (Merged → Open → Closed), dropping empty buckets and preserving input
 * order within each. The PR title is the first line of the Reference prose,
 * falling back to the locator (PR URL) when the prose is empty. An
 * unknown/null lifecycle is treated as `drafting` (open). Pure.
 */
export function groupPullRequestReferences(rows: PullRequestRefRow[]): PullRequestGroup[] {
  const byLifecycle = new Map<string, PullRequestItem[]>();
  for (const { lifecycle } of LIFECYCLE_GROUPS) byLifecycle.set(lifecycle, []);

  for (const row of rows) {
    const lifecycle = byLifecycle.has(row.lifecycle ?? "") ? (row.lifecycle as string) : "drafting";
    const url = row.locator ?? "";
    byLifecycle.get(lifecycle)?.push({
      id: row.id,
      title: firstLine(row.reference) || url,
      url,
      lifecycle,
    });
  }

  return LIFECYCLE_GROUPS.filter(
    ({ lifecycle }) => (byLifecycle.get(lifecycle)?.length ?? 0) > 0,
  ).map(({ lifecycle, label }) => ({ lifecycle, label, prs: byLifecycle.get(lifecycle) ?? [] }));
}

/**
 * Load the Pull requests perspective for a Doco: its GitHub connection status
 * plus its imported PR References grouped by lifecycle. PR References are
 * `reference` nodes whose promoted `locator` is a GitHub PR URL
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
  // no LIMIT), computed once as an InitPlan. `COUNT(*) OVER()` proved
  // unreliable under LIMIT on the production planner — it returned the page
  // limit, not the full count — and a result-row cap truncates windowed counts;
  // a plain aggregate subquery is immune to both, keeping totalCount/hasMore
  // correct on one round-trip.
  const { rows } = await c.query<PullRequestRefRowWithTotal>(
    `SELECT id,
            prose AS reference,
            locator,
            lifecycle,
            (SELECT COUNT(*)
               FROM nodes
              WHERE doco_id = $1
                AND node_type = 'reference'
                AND locator LIKE '%/pull/%') AS total_count
       FROM nodes
      WHERE doco_id = $1
        AND node_type = 'reference'
        AND locator LIKE '%/pull/%'
      ORDER BY created_at DESC, id ASC
      LIMIT $2`,
    [docoId, queryLimit],
  );
  const totalCount = Number(rows[0]?.total_count ?? 0);
  const visibleRows = rows.length > limit ? rows.slice(0, limit) : rows;
  const loadedCount = visibleRows.length;

  return {
    connected,
    groups: groupPullRequestReferences(visibleRows),
    loadedCount,
    totalCount,
    hasMore: totalCount > loadedCount,
  };
}
