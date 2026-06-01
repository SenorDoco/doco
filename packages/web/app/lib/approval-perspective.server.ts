import { DOCO_NODE_TABLE_SPECS } from "@doco/db";
import type { PerspectiveWindowSelection } from "./perspective-window.server";
import { windowNodeIds } from "./perspective-window.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const UPDATE_SEGMENTS: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  action: "actions",
  log: "logs",
  rule: "rules",
  eval: "evals",
  reference: "references",
  state: "states",
  idea: "ideas",
  principal: "principals",
};

export interface ApprovalPerspectiveNode {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string;
  created_at: string | null;
  proposed_at: string | null;
  author_id: string | null;
  author_name: string | null;
  href: string;
  update_url: string | null;
  zoom_href: string;
}

export interface ApprovalPerspectiveData {
  nodes: ApprovalPerspectiveNode[];
}

interface ApprovalRow {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: Date | string | null;
  proposed_at: Date | string | null;
  author_id: string | null;
  author_name: string | null;
}

interface ApprovalLoadOptions {
  limit?: number;
  window?: PerspectiveWindowSelection;
}

function normalizeLimit(value: number | null | undefined): number | null {
  if (value == null) return null;
  const limit = Math.floor(value);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function approvalRowsSql(): string {
  // Post-collapse: one `nodes` table. The approval queue covers every
  // node type plus principals (no lifecycle filter here — the outer CTE
  // filters to drafting). The display name is the first line of `prose`
  // for the 9 prose types; principals (prose='') fall back to `name`;
  // `id` is the final fallback.
  const types = DOCO_NODE_TABLE_SPECS.map((entry) => entry.entityType);
  const typeList = types.map((t) => `'${t}'`).join(", ");
  return `SELECT t.id,
                 t.node_type AS entity_type,
                 COALESCE(NULLIF(split_part(t.prose, E'\n', 1), ''), t.name, t.id) AS name,
                 COALESCE(t.lifecycle, 'asserted') AS lifecycle,
                 t.created_at,
                 t.created_by,
                 t.data->>'created_by_user_id' AS created_by_user_id
            FROM nodes t
           WHERE t.doco_id = $1
             AND t.node_type IN (${typeList})`;
}

export async function loadApprovalPerspectiveData(
  c: QueryClient,
  docoId: string,
  handle: string,
  options: ApprovalLoadOptions = {},
): Promise<ApprovalPerspectiveData> {
  const windowIds = windowNodeIds(options.window);
  const limit = normalizeLimit(options.limit);
  const params: unknown[] = [docoId];
  if (windowIds.length > 0) params.push(windowIds);
  else if (limit != null) params.push(limit);
  const rows = (
    await c.query<ApprovalRow>(
      `WITH proposed_events AS (
         SELECT DISTINCT ON (entity_type, entity_id)
                entity_type,
                entity_id,
                at,
                by_user
           FROM audit_events
          WHERE doco_id = $1
            AND op = 'lifecycle.transition'
            AND after_json->>'lifecycle' = 'drafting'
          ORDER BY entity_type, entity_id, at DESC
       ),
       proposed_nodes AS (
         SELECT *
           FROM (${approvalRowsSql()}) nodes
          WHERE lifecycle = 'drafting'
            ${windowIds.length > 0 ? "AND id = ANY($2::text[])" : ""}
       ),
       resolved_actors AS (
         SELECT n.*,
                pe.at AS proposed_at,
                COALESCE(
                  CASE WHEN left(pe.by_user, 13) = 'user_' THEN pe.by_user END,
                  CASE WHEN left(proposed_principal.created_by, 13) = 'user_' THEN proposed_principal.created_by END,
                  CASE WHEN left(n.created_by_user_id, 13) = 'user_' THEN n.created_by_user_id END,
                  CASE WHEN left(n.created_by, 13) = 'user_' THEN n.created_by END,
                  CASE WHEN left(created_principal.created_by, 13) = 'user_' THEN created_principal.created_by END
                ) AS author_id
           FROM proposed_nodes n
           LEFT JOIN proposed_events pe
             ON pe.entity_type = n.entity_type AND pe.entity_id = n.id
           LEFT JOIN nodes proposed_principal
             ON proposed_principal.node_type = 'principal'
            AND proposed_principal.doco_id = $1 AND proposed_principal.id = pe.by_user
           LEFT JOIN nodes created_principal
             ON created_principal.node_type = 'principal'
            AND created_principal.doco_id = $1 AND created_principal.id = n.created_by
       )
       SELECT n.id,
              n.entity_type,
              n.name,
              n.lifecycle,
              n.created_at,
              n.proposed_at,
              n.author_id,
              COALESCE(author.github_login, author.email, author.id) AS author_name
        FROM resolved_actors n
         LEFT JOIN users author ON author.id = n.author_id
        ORDER BY COALESCE(n.proposed_at, n.created_at) DESC NULLS LAST, n.id ASC
        ${windowIds.length === 0 && limit != null ? "LIMIT $2" : ""}`,
      params,
    )
  ).rows;

  return {
    nodes: rows.map((row) => {
      const href = `/${handle}/${row.entity_type}/${row.id}`;
      const updateSegment = UPDATE_SEGMENTS[row.entity_type];
      return {
        id: row.id,
        entity_type: row.entity_type,
        name: row.name,
        lifecycle: row.lifecycle ?? "drafting",
        created_at: toIso(row.created_at),
        proposed_at: toIso(row.proposed_at),
        author_id: row.author_id,
        author_name: row.author_name,
        href,
        update_url: updateSegment ? `/${handle}/api/${updateSegment}/${row.id}.json` : null,
        zoom_href: `${href}?dialog=skip`,
      };
    }),
  };
}
