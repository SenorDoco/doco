import { parse as parseYaml } from "yaml";
import type {
  OverviewGraphData,
  OverviewGraphLink,
  OverviewGraphNode,
  OverviewNodeDetail,
} from "~/components/overview-graph";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  attribution: string | null;
}

interface OverviewGraphRow {
  id: string;
  node_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
}

const GRAPH_TABLES: {
  table: string;
  nodeType: string;
  labelExpr?: string;
  nameExpr?: string;
}[] = [
  { table: "decisions", nodeType: "decision" },
  { table: "intents", nodeType: "intent" },
  { table: "actions", nodeType: "action" },
  { table: "logs", nodeType: "log" },
  { table: "rules", nodeType: "rule" },
  { table: "guidance_articles", nodeType: "guidance_article" },
  { table: "node_authoring_articles", nodeType: "node_authoring_article" },
  { table: "evals", nodeType: "eval" },
  { table: "reference_entities", nodeType: "reference" },
  { table: "ideas", nodeType: "idea" },
  { table: "states", nodeType: "state" },
];

const OVERVIEW_GRAPH_EDGE_LIMIT = 5000;
const OVERVIEW_DETAIL_LIMIT = 120;

function storedFrontmatter(rawYaml: string | null | undefined): Record<string, unknown> {
  if (!rawYaml) return {};
  try {
    const parsed = parseYaml(rawYaml);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function _useStoredFrontmatter() {
  // Re-exported as a no-op consumer to keep parseYaml + storedFrontmatter
  // available for callers that still want frontmatter helpers. Internal.
  storedFrontmatter(null);
}
void _useStoredFrontmatter;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asAttribution(value: string | null): "explicit" | "doco-auto" {
  return value === "doco-auto" ? "doco-auto" : "explicit";
}

function overviewEntityHref(
  handle: string | undefined,
  nodeType: string,
  id: string,
): string | undefined {
  if (!handle) return undefined;
  return `/${handle}/${nodeType}/${id}`;
}

function overviewRowsSql(includeLabel = false): string {
  return GRAPH_TABLES.map((entry) => {
    const labelExpr = entry.labelExpr ?? "t.summary";
    const nameExpr = entry.nameExpr ?? "NULL::text";
    return `SELECT t.id,
                   '${entry.nodeType}'::text AS node_type,
                   ${nameExpr} AS name,
                   COALESCE(t.lifecycle, 'active') AS lifecycle,
                   t.created_at::text AS created_at
                   ${includeLabel ? `, ${labelExpr} AS label` : ""}
              FROM ${entry.table} t
             WHERE t.doco_id = $1`;
  }).join(" UNION ALL ");
}

async function loadOverviewRows(c: QueryClient, docoId: string): Promise<OverviewGraphRow[]> {
  return (await c.query<OverviewGraphRow>(overviewRowsSql(), [docoId])).rows;
}

interface CrossDocoEdgeRow extends EdgeRow {
  to_doco_id: string;
}

async function loadOverviewLinks(
  c: QueryClient,
  docoId: string,
  nodeIds: string[],
): Promise<{ links: OverviewGraphLink[]; crossDocoTargets: Map<string, string> }> {
  if (nodeIds.length === 0) return { links: [], crossDocoTargets: new Map() };
  // Two UNIONed selects: intra-Doco edges (both endpoints local) and
  // cross-Doco outgoing edges (target lives in another Doco — per
  // add-document-edge-connections). The cross-Doco half is gated at
  // index-time by the access rule (same org or target public — see
  // @doco/index/cross-doco), so anything in `edges` here is already
  // authorized to materialize.
  const rows = (
    await c.query<CrossDocoEdgeRow>(
      `(SELECT from_id, to_id, edge_type, attribution, $1::text AS to_doco_id
          FROM edges
         WHERE doco_id = $1
           AND edge_type != 'in_scope_of'
           AND from_id = ANY($2::text[])
           AND to_id = ANY($2::text[]))
       UNION ALL
       (SELECT from_id, to_id, edge_type, attribution, to_doco_id
          FROM edges
         WHERE doco_id = $1
           AND edge_type != 'in_scope_of'
           AND from_id = ANY($2::text[])
           AND to_doco_id <> doco_id)
       ORDER BY 4, 3
       LIMIT $3`,
      [docoId, nodeIds, OVERVIEW_GRAPH_EDGE_LIMIT],
    )
  ).rows;
  const links: OverviewGraphLink[] = [];
  const crossDocoTargets = new Map<string, string>();
  for (const edge of rows) {
    links.push({
      source: edge.from_id,
      target: edge.to_id,
      edge_type: edge.edge_type,
      attribution: asAttribution(edge.attribution),
    });
    if (edge.to_doco_id !== docoId) {
      crossDocoTargets.set(edge.to_id, edge.to_doco_id);
    }
  }
  return { links, crossDocoTargets };
}

interface ForeignNodeRow extends OverviewGraphRow {
  doco_id: string;
}

function foreignNodesSql(): string {
  return GRAPH_TABLES.map((entry) => {
    const nameExpr = entry.nameExpr ?? "NULL::text";
    return `SELECT t.id,
                   '${entry.nodeType}'::text AS node_type,
                   ${nameExpr} AS name,
                   COALESCE(t.lifecycle, 'active') AS lifecycle,
                   t.created_at::text AS created_at,
                   t.doco_id AS doco_id
              FROM ${entry.table} t
             WHERE t.id = ANY($1::text[])`;
  }).join(" UNION ALL ");
}

async function loadForeignTargetNodes(
  c: QueryClient,
  crossDocoTargets: Map<string, string>,
): Promise<OverviewGraphNode[]> {
  if (crossDocoTargets.size === 0) return [];
  const targetIds = [...crossDocoTargets.keys()];
  const docoIds = [...new Set(crossDocoTargets.values())];
  const [nodeRowsRes, handleRowsRes] = await Promise.all([
    c.query<ForeignNodeRow>(foreignNodesSql(), [targetIds]),
    c.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM docos WHERE id = ANY($1::text[])",
      [docoIds],
    ),
  ]);
  const handleByDocoId = new Map(handleRowsRes.rows.map((r) => [r.id, r.handle]));
  return nodeRowsRes.rows.map((row) => {
    const handle = handleByDocoId.get(row.doco_id);
    return {
      id: row.id,
      node_type: row.node_type,
      name: row.name,
      lifecycle: row.lifecycle ?? "active",
      created_at: toIso(row.created_at),
      href: handle ? overviewEntityHref(handle, row.node_type, row.id) : undefined,
      external_doco_handle: handle ?? undefined,
    };
  });
}

export async function loadOverviewGraph(
  c: QueryClient,
  docoId: string,
  options: { centerId?: string; handle?: string } = {},
): Promise<OverviewGraphData> {
  const rows = await loadOverviewRows(c, docoId);
  const nodeIds = rows.map((row) => row.id);
  const { links, crossDocoTargets } = await loadOverviewLinks(c, docoId, nodeIds);
  const localNodes: OverviewGraphNode[] = rows.map((row) => ({
    id: row.id,
    node_type: row.node_type,
    name: row.name,
    lifecycle: row.lifecycle ?? "active",
    created_at: toIso(row.created_at),
    href: overviewEntityHref(options.handle, row.node_type, row.id),
    is_center: row.id === options.centerId,
  }));
  const foreignNodes = await loadForeignTargetNodes(c, crossDocoTargets);
  const nodes = [...localNodes, ...foreignNodes];
  const centerId =
    (options.centerId && nodes.some((node) => node.id === options.centerId)
      ? options.centerId
      : null) ??
    nodes[0]?.id ??
    options.centerId ??
    docoId;

  return {
    centerId,
    nodes,
    links,
    detailUrl: options.handle ? `/${options.handle}/graph-node-details.json` : null,
  };
}

export async function loadOverviewNodeDetails(
  c: QueryClient,
  docoId: string,
  ids: string[],
  handle?: string,
): Promise<OverviewNodeDetail[]> {
  const requested = Array.from(new Set(ids.filter(Boolean))).slice(0, OVERVIEW_DETAIL_LIMIT);
  if (requested.length === 0) return [];
  const rows = (
    await c.query<
      OverviewGraphRow & {
        label: string | null;
      }
    >(
      `SELECT *
         FROM (${overviewRowsSql(true)}) nodes
        WHERE id = ANY($2::text[])`,
      [docoId, requested],
    )
  ).rows;
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return requested.flatMap((id) => {
    const row = rowById.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        node_type: row.node_type,
        summary: row.label ?? row.name ?? row.id,
        name: row.name,
        lifecycle: row.lifecycle ?? "active",
        created_at: toIso(row.created_at),
        href: overviewEntityHref(handle, row.node_type, row.id),
      },
    ];
  });
}
