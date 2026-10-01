// One row per workspace a person reaches, for the Workspaces page and the top
// of each workspace's page: its Docos (with the template each came from, for
// the type icon), the person's role, when it last saw activity, and the open
// silence alerts about the Docos they reach.
//
// A person reaches a workspace by membership (every live Doco in it) or by a
// Doco invite (just the Docos they were invited to; role is null).

import { COPIED_ITEMS_SQL } from "./doco-stats.server";
import { type SilenceAlert, loadSilenceAlerts } from "./silence-alerts.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type WorkspaceRole = "owner" | "writer" | "reader";

export interface WorkspaceSummaryDoco {
  id: string;
  handle: string;
  /** The template the Doco was created from; null for a Doco made before templates were recorded. */
  template: string | null;
}

export interface WorkspaceSummary {
  id: string;
  handle: string;
  name: string;
  /** The person's membership role; null when they reach only some of its Docos. */
  role: WorkspaceRole | null;
  docos: WorkspaceSummaryDoco[];
  /** When the latest change landed in any of its Docos; null when none has. */
  lastActivityAt: string | null;
  /** Integrations and agents gone unexpectedly quiet in its Docos. */
  alerts: SilenceAlert[];
}

export async function loadWorkspaceSummaries(
  c: QueryClient,
  userId: string,
  opts: { workspaceId?: string } = {},
): Promise<WorkspaceSummary[]> {
  const workspaceFilter = opts.workspaceId ?? null;
  const docoRows = await c.query<{
    id: string;
    handle: string;
    template: string | null;
    workspace_id: string;
  }>(
    `SELECT d.id, d.handle, d.data->>'template_handle' AS template, d.workspace_id
       FROM docos d
      WHERE d.deleted_at IS NULL
        AND ($2::text IS NULL OR d.workspace_id = $2)
        AND (
          d.workspace_id IN (SELECT workspace_id FROM workspace_users WHERE user_id = $1)
          OR d.id IN (SELECT doco_id FROM doco_users WHERE user_id = $1)
        )
      ORDER BY d.handle`,
    [userId, workspaceFilter],
  );
  const workspaceRows = await c.query<{
    id: string;
    handle: string;
    name: string;
    role: WorkspaceRole | null;
  }>(
    `SELECT w.id, w.handle, w.name, wu.role
       FROM workspaces w
       LEFT JOIN workspace_users wu ON wu.workspace_id = w.id AND wu.user_id = $1
      WHERE ($3::text IS NULL OR w.id = $3)
        AND (wu.user_id IS NOT NULL OR w.id = ANY($2::text[]))`,
    [userId, docoRows.rows.map((d) => d.workspace_id), workspaceFilter],
  );
  const activityRows = await c.query<{ workspace_id: string; at: Date | string }>(
    // Policy edits aren't project activity; what a Doco copies from its source is.
    `SELECT d.workspace_id, MAX(e.at) AS at
       FROM (SELECT doco_id, at FROM audit_events WHERE entity_type <> 'policy'
             UNION ALL
             SELECT doco_id, at FROM (${COPIED_ITEMS_SQL}) copied) e
       JOIN docos d ON d.id = e.doco_id
      WHERE e.doco_id = ANY($1::text[])
      GROUP BY d.workspace_id`,
    [docoRows.rows.map((d) => d.id)],
  );
  const lastActivityAt = new Map(
    activityRows.rows.map((r) => [r.workspace_id, new Date(r.at).toISOString()]),
  );
  const alerts = await loadSilenceAlerts(
    c,
    docoRows.rows.map((d) => d.id),
  );

  return workspaceRows.rows
    .map(
      (w): WorkspaceSummary => ({
        id: w.id,
        handle: w.handle,
        name: w.name,
        role: w.role,
        docos: docoRows.rows
          .filter((d) => d.workspace_id === w.id)
          .map((d) => ({ id: d.id, handle: d.handle, template: d.template })),
        lastActivityAt: lastActivityAt.get(w.id) ?? null,
        alerts: alerts.filter((a) => a.workspaceHandle === w.handle),
      }),
    )
    .sort((a, b) => {
      const at = a.lastActivityAt ?? "";
      const bt = b.lastActivityAt ?? "";
      if (at !== bt) return bt.localeCompare(at);
      return a.handle.localeCompare(b.handle);
    });
}
