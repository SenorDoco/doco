import { ALL_ENTITY_TABLES, DOCO_NEURON_TABLE_SPECS } from "@doco/db";

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
  created_by: string | null;
  proposed_at: Date | string | null;
  author_name: string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function approvalRowsSql(): string {
  const neuronLegs = DOCO_NEURON_TABLE_SPECS.map((entry) => {
    const tnCol = ALL_ENTITY_TABLES[entry.entityType]?.typeNamedColumn;
    const labelExpr = entry.labelExpr ?? (tnCol ? `split_part(t.${tnCol}, E'\n', 1)` : "t.summary");
    const nameExpr = entry.nameExpr ?? "NULL::text";
    return `SELECT t.id,
                   '${entry.entityType}'::text AS entity_type,
                   COALESCE(NULLIF(${labelExpr}, ''), ${nameExpr}, t.id) AS name,
                   COALESCE(t.lifecycle, 'active') AS lifecycle,
                   t.created_at,
                   t.created_by
              FROM ${entry.table} t
             WHERE t.doco_id = $1`;
  });
  const principalLeg = `SELECT id,
                               'principal'::text AS entity_type,
                               name,
                               COALESCE(lifecycle, 'active') AS lifecycle,
                               created_at,
                               created_by
                          FROM principals
                         WHERE doco_id = $1`;
  return [...neuronLegs, principalLeg].join(" UNION ALL ");
}

export async function loadApprovalPerspectiveData(
  c: QueryClient,
  docoId: string,
  handle: string,
): Promise<ApprovalPerspectiveData> {
  const rows = (
    await c.query<ApprovalRow>(
      `WITH proposed_events AS (
         SELECT DISTINCT ON (entity_type, entity_id)
                entity_type,
                entity_id,
                at,
                by_collaborator
           FROM audit_events
          WHERE doco_id = $1
            AND op = 'lifecycle.transition'
            AND after_json->>'lifecycle' = 'proposed'
          ORDER BY entity_type, entity_id, at DESC
       ),
       proposed_nodes AS (
         SELECT *
           FROM (${approvalRowsSql()}) nodes
          WHERE lifecycle = 'proposed'
       )
       SELECT n.id,
              n.entity_type,
              n.name,
              n.lifecycle,
              n.created_at,
              n.created_by,
              pe.at AS proposed_at,
              COALESCE(author.github_login, author.email, author.id, n.created_by) AS author_name
         FROM proposed_nodes n
         LEFT JOIN proposed_events pe
           ON pe.entity_type = n.entity_type AND pe.entity_id = n.id
         LEFT JOIN collaborators author ON author.id = n.created_by
        ORDER BY COALESCE(pe.at, n.created_at) DESC NULLS LAST, n.id ASC`,
      [docoId],
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
        lifecycle: row.lifecycle ?? "proposed",
        created_at: toIso(row.created_at),
        proposed_at: toIso(row.proposed_at),
        author_id: row.created_by,
        author_name: row.author_name,
        href,
        update_url: updateSegment ? `/${handle}/api/${updateSegment}/${row.id}.json` : null,
        zoom_href: `${href}?dialog=skip`,
      };
    }),
  };
}
