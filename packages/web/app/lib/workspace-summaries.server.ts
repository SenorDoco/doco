// One row per workspace a person reaches, for the Workspaces page and the top
// of each workspace's page: its Docos (with the template each came from, for
// the type icon), the person's role, and the latest thing that happened in it.
//
// A person reaches a workspace by membership (every live Doco in it) or by a
// Doco invite (just the Docos they were invited to; role is null).

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

export interface WorkspaceLastActivity {
  at: string;
  byUsername: string | null;
  op: string;
  entityType: string;
  entityId: string;
  docoHandle: string;
  /** First line of the node's prose, when the entity is a node. */
  summary: string | null;
}

export interface WorkspaceSummary {
  id: string;
  handle: string;
  name: string;
  /** The person's membership role; null when they reach only some of its Docos. */
  role: WorkspaceRole | null;
  docos: WorkspaceSummaryDoco[];
  lastActivity: WorkspaceLastActivity | null;
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
  const activityRows = await c.query<{
    workspace_id: string;
    at: Date | string;
    by_username: string | null;
    op: string;
    entity_type: string;
    entity_id: string;
    doco_handle: string;
    summary: string | null;
  }>(
    // The latest event per Doco rides the (doco_id, at) index; the latest of
    // those per workspace wins. Policy edits aren't project activity.
    `SELECT DISTINCT ON (d.workspace_id)
            d.workspace_id, e.at, e.op, e.entity_type, e.entity_id,
            d.handle AS doco_handle,
            COALESCE(u.github_login, u.email, u.id) AS by_username,
            NULLIF(split_part(n.prose, E'\\n', 1), '') AS summary
       FROM docos d
       CROSS JOIN LATERAL (
         SELECT a.at, a.op, a.entity_type, a.entity_id, a.by_user
           FROM audit_events a
          WHERE a.doco_id = d.id AND a.entity_type <> 'policy'
          ORDER BY a.at DESC
          LIMIT 1
       ) e
       LEFT JOIN users u ON u.id = e.by_user
       LEFT JOIN nodes n ON n.id = e.entity_id
      WHERE d.id = ANY($1::text[])
      ORDER BY d.workspace_id, e.at DESC`,
    [docoRows.rows.map((d) => d.id)],
  );

  const activityByWorkspace = new Map<string, WorkspaceLastActivity>();
  for (const r of activityRows.rows) {
    activityByWorkspace.set(r.workspace_id, {
      at: new Date(r.at).toISOString(),
      byUsername: r.by_username,
      op: r.op,
      entityType: r.entity_type,
      entityId: r.entity_id,
      docoHandle: r.doco_handle,
      summary: r.summary,
    });
  }

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
        lastActivity: activityByWorkspace.get(w.id) ?? null,
      }),
    )
    .sort((a, b) => {
      const at = a.lastActivity?.at ?? "";
      const bt = b.lastActivity?.at ?? "";
      if (at !== bt) return bt.localeCompare(at);
      return a.handle.localeCompare(b.handle);
    });
}
