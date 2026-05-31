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
}

// Display order + human labels for the three PR lifecycle buckets. Merged
// (the settled, shipped outcome) leads, then Open work in motion, then Closed.
const LIFECYCLE_GROUPS: { lifecycle: string; label: string }[] = [
  { lifecycle: "asserted", label: "Merged" },
  { lifecycle: "drafting", label: "Open" },
  { lifecycle: "retired", label: "Closed" },
];

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
): Promise<PullRequestsPerspectiveData> {
  const connectionCtx = await getDocoConnectionsContext(docoId);
  const connected = (connectionCtx?.connections.length ?? 0) > 0;

  const { rows } = await c.query<PullRequestRefRow>(
    `SELECT id, prose AS reference, locator, lifecycle
       FROM nodes
      WHERE doco_id = $1
        AND node_type = 'reference'
        AND locator LIKE '%/pull/%'
      ORDER BY created_at DESC, id ASC`,
    [docoId],
  );

  return { connected, groups: groupPullRequestReferences(rows) };
}
