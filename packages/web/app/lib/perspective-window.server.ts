type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type DefaultFocusStrategy = "central" | "workspace-root";

type WindowReason = "explicit_focus" | "default_focus" | "neighbor" | "ranked_fill";

export interface PerspectiveWindowSpec {
  key: string;
  nodeTypes: readonly string[];
  /**
   * When set, retired nodes are dropped from window selection. No spec sets
   * this today: every perspective renders the page-level lifecycle filter, so
   * retired must stay in the window and let the client (`visibleLifecycles`,
   * retired hidden by default) decide. Excluding retired here gates the
   * loaders' `id = ANY(window)`, which would make toggling "Retired" on a
   * no-op (the BPMN PR #819 bug). The graph spec already keeps
   * retired in the window; `rankOrderSql` sorts retired last so they never
   * crowd active nodes out of the budget.
   */
  excludeRetired?: boolean;
  defaultFocusStrategy?: DefaultFocusStrategy;
  typeWeights?: Readonly<Record<string, number>>;
}

export interface PerspectiveWindowSelection {
  focusNodeId: string | null;
  nodeIds: string[];
}

export interface PerspectiveWindow extends PerspectiveWindowSelection {
  reasonByNodeId: Record<string, WindowReason>;
  totalEligibleByType: Record<string, number>;
  omittedCountsByType: Record<string, number>;
  hasMore: boolean;
}

interface CountRow {
  node_type: string;
  n: string | number;
}

interface WindowNodeRow {
  id: string;
  node_type: string;
  lifecycle: string | null;
  created_at: string | null;
  updated_at?: string | null;
  degree?: string | number | null;
}

const ALL_NODE_TYPES = [
  "decision",
  "intent",
  "action",
  "log",
  "rule",
  "eval",
  "reference",
  "state",
  "idea",
  "principal",
] as const;
const BPMN_NODE_TYPES = [
  "decision",
  "intent",
  "action",
  "rule",
  "eval",
  "reference",
  "state",
  "idea",
  "principal",
] as const;
const SLA_NODE_TYPES = ["rule", "eval", "reference", "action", "decision", "principal"] as const;
const GLOSSARY_NODE_TYPES = ["decision", "reference", "rule", "eval", "intent"] as const;

const DEFAULT_TYPE_WEIGHTS: Record<string, number> = {
  decision: 100,
  intent: 90,
  action: 80,
  rule: 70,
  eval: 60,
  state: 55,
  reference: 50,
  idea: 40,
  principal: 30,
  log: 20,
};

export const PERSPECTIVE_WINDOW_SPECS = {
  graph: {
    key: "graph",
    nodeTypes: ALL_NODE_TYPES,
    typeWeights: DEFAULT_TYPE_WEIGHTS,
  },
  bpmn: {
    key: "bpmn",
    nodeTypes: BPMN_NODE_TYPES,
    typeWeights: {
      intent: 100,
      action: 90,
      decision: 85,
      state: 75,
      rule: 60,
      eval: 55,
      reference: 45,
      principal: 35,
      idea: 25,
    },
  },
  "org-tree": {
    key: "org-tree",
    nodeTypes: ["principal"],
    defaultFocusStrategy: "workspace-root",
    typeWeights: { principal: 100 },
  },
  sla: {
    key: "sla",
    nodeTypes: SLA_NODE_TYPES,
    typeWeights: {
      rule: 100,
      eval: 80,
      reference: 70,
      action: 60,
      decision: 50,
      principal: 40,
    },
  },
  glossary: {
    key: "glossary",
    nodeTypes: GLOSSARY_NODE_TYPES,
    typeWeights: {
      decision: 100,
      reference: 95,
      rule: 80,
      eval: 70,
      intent: 60,
    },
  },
} satisfies Record<string, PerspectiveWindowSpec>;

export async function selectPerspectiveWindow(
  c: QueryClient,
  args: {
    docoId: string;
    explicitFocusNodeId: string | null | undefined;
    limit: number;
    spec: PerspectiveWindowSpec;
  },
): Promise<PerspectiveWindow> {
  const limit = Math.max(1, Math.floor(args.limit));
  const totalEligibleByType = await loadEligibleCounts(c, args.docoId, args.spec);
  const explicitFocusNodeId = args.explicitFocusNodeId?.trim() || null;
  const defaultFocus = explicitFocusNodeId
    ? null
    : await loadDefaultFocus(c, args.docoId, args.spec);
  const focusNodeId = explicitFocusNodeId ?? defaultFocus?.id ?? null;

  const [neighbors, ranked] = await Promise.all([
    focusNodeId ? loadFocusNeighbors(c, args.docoId, args.spec, focusNodeId, limit) : [],
    loadRankedFill(c, args.docoId, args.spec, Math.max(limit * 2, limit + 25)),
  ]);

  const candidateById = new Map<string, WindowNodeRow>();
  if (defaultFocus) candidateById.set(defaultFocus.id, defaultFocus);
  for (const row of neighbors) candidateById.set(row.id, row);
  for (const row of ranked) candidateById.set(row.id, row);

  const nodeIds: string[] = [];
  const reasonByNodeId: Record<string, WindowReason> = {};
  const add = (id: string | null | undefined, reason: WindowReason) => {
    if (!id || nodeIds.length >= limit || reasonByNodeId[id]) return;
    nodeIds.push(id);
    reasonByNodeId[id] = reason;
  };

  add(explicitFocusNodeId, "explicit_focus");
  if (!explicitFocusNodeId) add(defaultFocus?.id, "default_focus");
  for (const row of neighbors) add(row.id, "neighbor");
  for (const row of ranked) add(row.id, "ranked_fill");

  const selectedKnownByType: Record<string, number> = {};
  for (const id of nodeIds) {
    const row = candidateById.get(id);
    if (!row) continue;
    selectedKnownByType[row.node_type] = (selectedKnownByType[row.node_type] ?? 0) + 1;
  }

  const omittedCountsByType: Record<string, number> = {};
  for (const [type, count] of Object.entries(totalEligibleByType)) {
    const omitted = count - (selectedKnownByType[type] ?? 0);
    if (omitted > 0) omittedCountsByType[type] = omitted;
  }

  return {
    focusNodeId,
    nodeIds,
    reasonByNodeId,
    totalEligibleByType,
    omittedCountsByType,
    hasMore: Object.values(omittedCountsByType).some((count) => count > 0),
  };
}

export function windowNodeIds(window: PerspectiveWindowSelection | null | undefined): string[] {
  return window?.nodeIds?.filter(Boolean) ?? [];
}

function typeList(spec: PerspectiveWindowSpec): string[] {
  return [...new Set(spec.nodeTypes)];
}

async function loadEligibleCounts(
  c: QueryClient,
  docoId: string,
  spec: PerspectiveWindowSpec,
): Promise<Record<string, number>> {
  const rows = (
    await c.query<CountRow>(
      `SELECT n.node_type, COUNT(*)::text AS n
         FROM nodes n
        WHERE n.doco_id = $1
          AND n.node_type = ANY($2::text[])
          ${lifecyclePredicate("n", spec)}
        GROUP BY node_type`,
      [docoId, typeList(spec)],
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.node_type, Number(row.n) || 0]));
}

async function loadDefaultFocus(
  c: QueryClient,
  docoId: string,
  spec: PerspectiveWindowSpec,
): Promise<WindowNodeRow | null> {
  const rows = (
    await c.query<WindowNodeRow>(
      `WITH node_degrees AS (
         SELECT ref_id AS id, COUNT(*)::int AS degree
           FROM (
             SELECT from_id AS ref_id FROM edges WHERE doco_id = $1
             UNION ALL
             SELECT to_id AS ref_id FROM edges WHERE doco_id = $1
           ) refs
          GROUP BY ref_id
       )
       SELECT n.id,
              n.node_type,
              COALESCE(n.lifecycle, 'active') AS lifecycle,
              n.created_at::text AS created_at,
              n.updated_at::text AS updated_at,
              COALESCE(d.degree, 0)::text AS degree
         FROM nodes n
         LEFT JOIN node_degrees d ON d.id = n.id
        WHERE n.doco_id = $1
          AND n.node_type = ANY($2::text[])
          ${lifecyclePredicate("n", spec)}
        ORDER BY ${defaultFocusOrderSql("n", spec)}
        LIMIT 1`,
      [docoId, typeList(spec)],
    )
  ).rows;
  return rows[0] ?? null;
}

async function loadFocusNeighbors(
  c: QueryClient,
  docoId: string,
  spec: PerspectiveWindowSpec,
  focusNodeId: string,
  limit: number,
): Promise<WindowNodeRow[]> {
  return (
    await c.query<WindowNodeRow>(
      `WITH edge_neighbors AS (
         SELECT CASE WHEN e.from_id = $3 THEN e.to_id ELSE e.from_id END AS id,
                COUNT(*)::int AS neighbor_degree
           FROM edges e
          WHERE e.doco_id = $1
            AND (e.from_id = $3 OR e.to_id = $3)
            AND COALESCE(e.lifecycle, 'active') <> 'retired'
          GROUP BY id
       ),
       node_degrees AS (
         SELECT ref_id AS id, COUNT(*)::int AS degree
           FROM (
             SELECT from_id AS ref_id FROM edges WHERE doco_id = $1
             UNION ALL
             SELECT to_id AS ref_id FROM edges WHERE doco_id = $1
           ) refs
          GROUP BY ref_id
       )
       SELECT n.id,
              n.node_type,
              COALESCE(n.lifecycle, 'active') AS lifecycle,
              n.created_at::text AS created_at,
              n.updated_at::text AS updated_at,
              COALESCE(d.degree, edge_neighbors.neighbor_degree, 0)::text AS degree
         FROM edge_neighbors
         JOIN nodes n ON n.id = edge_neighbors.id
         LEFT JOIN node_degrees d ON d.id = n.id
        WHERE n.doco_id = $1
          AND n.node_type = ANY($2::text[])
          ${lifecyclePredicate("n", spec)}
        ORDER BY edge_neighbors.neighbor_degree DESC,
                 ${rankOrderSql("n", spec)}
        LIMIT $4`,
      [docoId, typeList(spec), focusNodeId, limit],
    )
  ).rows;
}

async function loadRankedFill(
  c: QueryClient,
  docoId: string,
  spec: PerspectiveWindowSpec,
  limit: number,
): Promise<WindowNodeRow[]> {
  return (
    await c.query<WindowNodeRow>(
      `WITH node_degrees AS (
         SELECT ref_id AS id, COUNT(*)::int AS degree
           FROM (
             SELECT from_id AS ref_id FROM edges WHERE doco_id = $1
             UNION ALL
             SELECT to_id AS ref_id FROM edges WHERE doco_id = $1
           ) refs
          GROUP BY ref_id
       )
       SELECT n.id,
              n.node_type,
              COALESCE(n.lifecycle, 'active') AS lifecycle,
              n.created_at::text AS created_at,
              n.updated_at::text AS updated_at,
              COALESCE(d.degree, 0)::text AS degree
         FROM nodes n
         LEFT JOIN node_degrees d ON d.id = n.id
        WHERE n.doco_id = $1
          AND n.node_type = ANY($2::text[])
          ${lifecyclePredicate("n", spec)}
        ORDER BY ${rankOrderSql("n", spec)}
        LIMIT $3`,
      [docoId, typeList(spec), limit],
    )
  ).rows;
}

function lifecyclePredicate(alias: string, spec: PerspectiveWindowSpec): string {
  return spec.excludeRetired ? `AND COALESCE(${alias}.lifecycle, 'active') <> 'retired'` : "";
}

function defaultFocusOrderSql(alias: string, spec: PerspectiveWindowSpec): string {
  if (spec.defaultFocusStrategy === "workspace-root") {
    return `CASE WHEN NOT EXISTS (
              SELECT 1
                FROM edges root_edge
               WHERE root_edge.doco_id = ${alias}.doco_id
                 AND root_edge.edge_type = 'has_parent'
                 AND root_edge.from_id = ${alias}.id
                 AND COALESCE(root_edge.lifecycle, 'active') <> 'retired'
            ) THEN 0 ELSE 1 END,
            ${rankOrderSql(alias, spec)}`;
  }
  return rankOrderSql(alias, spec);
}

function rankOrderSql(alias: string, spec: PerspectiveWindowSpec): string {
  return `${typeWeightCaseSql(alias, spec)} DESC,
          CASE COALESCE(${alias}.lifecycle, 'active')
            WHEN 'active' THEN 0
            WHEN 'queued' THEN 1
            WHEN 'drafting' THEN 2
            WHEN 'retired' THEN 9
            ELSE 5
          END,
          COALESCE(d.degree, 0) DESC,
          ${alias}.updated_at DESC NULLS LAST,
          ${alias}.created_at DESC NULLS LAST,
          ${alias}.id ASC`;
}

function typeWeightCaseSql(alias: string, spec: PerspectiveWindowSpec): string {
  const weights = spec.typeWeights ?? DEFAULT_TYPE_WEIGHTS;
  const cases = Object.entries(weights)
    .map(([type, weight]) => `WHEN '${sqlLiteral(type)}' THEN ${Number(weight) || 0}`)
    .join(" ");
  return `CASE ${alias}.node_type ${cases} ELSE 0 END`;
}

function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
