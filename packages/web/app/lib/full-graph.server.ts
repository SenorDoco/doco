import { DOCO_NODE_TABLE_SPECS } from "@doco/db";
import { parse as parseYaml } from "yaml";
import type {
  OverviewGraphData,
  OverviewGraphLink,
  OverviewGraphNode,
  OverviewNodeDetail,
} from "~/components/overview-graph";
import type { PerspectiveWindowSelection } from "./perspective-window.server";
import { windowNodeIds } from "./perspective-window.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  edge_type: string;
  lifecycle: string | null;
  doco_id?: string;
}

interface OverviewGraphRow {
  id: string;
  entity_type: string;
  name: string | null;
  label?: string | null;
  lifecycle: string | null;
  created_at: string | null;
  /** Scalar-subquery total of graph-eligible nodes — the full filtered total,
   *  repeated on every row (computed independently of the page LIMIT). pg
   *  returns the bigint as a string. Absent on the node-details query. */
  total_node_count?: number | string | null;
}

// Note tables only — policies are not
// nodes and are deliberately excluded from the graph. Policies
// have their own surface: /<handle>/policies and
// /<handle>/api/policies.json.
const GRAPH_TABLES = DOCO_NODE_TABLE_SPECS;

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

function overviewEntityHref(
  handle: string | undefined,
  entityType: string,
  id: string,
): string | undefined {
  if (!handle) return undefined;
  return `/${handle}/${entityType}/${id}`;
}

function overviewEdgeHref(handle: string | undefined, id: string): string | undefined {
  if (!handle) return undefined;
  return `/${handle}/edges/${id}`;
}

function overviewRowsSql(includeLabel = false): string {
  // Post-collapse + slim-down: one `nodes` table discriminated by
  // `node_type`, and the `name` column was dropped — every type
  // (principals included) carries its label in `prose`. The label is the
  // first line of `prose`; `name` is kept principal-only (NULL for prose
  // types) to match the old column's shape. Principals also drop retired
  // role-personas (the other types don't filter lifecycle here), so the
  // lifecycle filter is principal-scoped.
  const types = GRAPH_TABLES.map((entry) => entry.entityType);
  const typeList = types.map((t) => `'${t}'`).join(", ");
  const labelExpr = "NULLIF(split_part(t.prose, E'\n', 1), '')";
  return `SELECT t.id,
                 t.node_type AS entity_type,
                 CASE WHEN t.node_type = 'principal' THEN NULLIF(t.prose, '') END AS name,
                 COALESCE(t.lifecycle, 'active') AS lifecycle,
                 t.created_at::text AS created_at
                 ${includeLabel ? `, ${labelExpr} AS label` : ""}
            FROM nodes t
           WHERE t.doco_id = $1
             AND t.node_type IN (${typeList})
             AND (t.node_type <> 'principal' OR COALESCE(t.lifecycle, 'active') = 'active')`;
}

async function loadOverviewRows(
  c: QueryClient,
  docoId: string,
  options: { centerId?: string; limit?: number; window?: PerspectiveWindowSelection } = {},
): Promise<OverviewGraphRow[]> {
  const windowIds = windowNodeIds(options.window);
  if (windowIds.length > 0) {
    return (
      await c.query<OverviewGraphRow>(
        `SELECT *, (SELECT COUNT(*) FROM (${overviewRowsSql(false)}) c) AS total_node_count
           FROM (${overviewRowsSql(true)}) nodes
          WHERE id = ANY($2::text[])
          ORDER BY array_position($2::text[], id) NULLS LAST, id`,
        [docoId, windowIds],
      )
    ).rows;
  }

  const limit = options.limit ? Math.max(1, Math.floor(options.limit)) : null;
  const params: unknown[] = [docoId];
  let limitSql = "";
  if (limit !== null) {
    params.push(limit, options.centerId ?? "");
    limitSql = "LIMIT $2";
  }
  return (
    await c.query<OverviewGraphRow>(
      `SELECT *, (SELECT COUNT(*) FROM (${overviewRowsSql(false)}) c) AS total_node_count
         FROM (${overviewRowsSql(true)}) nodes
        ORDER BY
          ${limit !== null ? "id = $3 DESC," : ""}
          CASE COALESCE(lifecycle, 'active')
            WHEN 'active' THEN 0
            WHEN 'queued' THEN 1
            WHEN 'drafting' THEN 2
            WHEN 'retired' THEN 3
            ELSE 4
          END,
          created_at DESC NULLS LAST,
          id
        ${limitSql}`,
      params,
    )
  ).rows;
}

async function loadOverviewLinks(
  c: QueryClient,
  docoId: string,
  nodeIds: string[],
): Promise<OverviewGraphLink[]> {
  if (nodeIds.length === 0) return [];
  const rows = (
    await c.query<EdgeRow>(
      `SELECT id, from_id, to_id, edge_type, COALESCE(lifecycle, 'active') AS lifecycle
         FROM edges
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND to_id = ANY($2::text[])
        ORDER BY edge_type
        LIMIT $3`,
      [docoId, nodeIds, OVERVIEW_GRAPH_EDGE_LIMIT],
    )
  ).rows;
  return rows.map((s) => ({
    id: s.id,
    source: s.from_id,
    target: s.to_id,
    edge_type: s.edge_type,
    lifecycle: s.lifecycle ?? "active",
    href: overviewEdgeHref(undefined, s.id),
  }));
}

export async function loadOverviewGraph(
  c: QueryClient,
  docoId: string,
  options: {
    centerId?: string;
    handle?: string;
    limit?: number;
    window?: PerspectiveWindowSelection;
  } = {},
): Promise<OverviewGraphData> {
  const rows = await loadOverviewRows(c, docoId, {
    centerId: options.centerId,
    limit: options.limit,
    window: options.window,
  });
  const nodeIds = rows.map((row) => row.id);
  const links = await loadOverviewLinks(c, docoId, nodeIds);
  const linksWithHrefs = links.map((link) => ({
    ...link,
    href: link.id ? overviewEdgeHref(options.handle, link.id) : link.href,
  }));
  const nodes: OverviewGraphNode[] = rows.map((row) => ({
    id: row.id,
    entity_type: row.entity_type,
    name: row.label ?? row.name,
    lifecycle: row.lifecycle ?? "active",
    created_at: toIso(row.created_at),
    href: overviewEntityHref(options.handle, row.entity_type, row.id),
    is_center: row.id === (options.centerId ?? options.window?.focusNodeId ?? undefined),
  }));
  const requestedCenterId = options.centerId ?? options.window?.focusNodeId ?? undefined;
  const centerId =
    (requestedCenterId && nodes.some((node) => node.id === requestedCenterId)
      ? requestedCenterId
      : null) ??
    nodes[0]?.id ??
    requestedCenterId ??
    docoId;

  // True total of graph-eligible nodes (the windowed count, computed before the
  // slice limit). `hasMore` drives the List header's "Showing the latest N of M"
  // line; the focus-window path counts only its own rows, so it's never "more".
  const totalNodeCount = Number(rows[0]?.total_node_count ?? 0);

  return {
    centerId,
    nodes,
    links: linksWithHrefs,
    detailUrl: options.handle ? `/${options.handle}/graph-node-details.json` : null,
    totalNodeCount,
    hasMore: totalNodeCount > nodes.length,
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
        entity_type: row.entity_type,
        summary: row.label ?? row.name ?? row.id,
        name: row.name,
        lifecycle: row.lifecycle ?? "active",
        created_at: toIso(row.created_at),
        href: overviewEntityHref(handle, row.entity_type, row.id),
      },
    ];
  });
}
