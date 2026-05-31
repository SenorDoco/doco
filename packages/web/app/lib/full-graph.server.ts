import { DOCO_NODE_TABLE_SPECS } from "@doco/db";
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
}

interface OverviewGraphRow {
  id: string;
  entity_type: string;
  name: string | null;
  label?: string | null;
  lifecycle: string | null;
  created_at: string | null;
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

function overviewRowsSql(includeLabel = false): string {
  // Post-collapse: one `nodes` table discriminated by `node_type`. The
  // graph renders every node type plus principals. For the 9 prose
  // types the label is the first line of `prose`; principals carry
  // prose='' and fall back to their `name`. Principals also drop
  // retired role-personas (the other types don't filter lifecycle
  // here), so the lifecycle filter is principal-scoped.
  const types = [...GRAPH_TABLES.map((entry) => entry.entityType), "principal"];
  const typeList = types.map((t) => `'${t}'`).join(", ");
  const labelExpr = "COALESCE(NULLIF(split_part(t.prose, E'\n', 1), ''), t.name)";
  return `SELECT t.id,
                 t.node_type AS entity_type,
                 t.name,
                 COALESCE(t.lifecycle, 'asserted') AS lifecycle,
                 t.created_at::text AS created_at
                 ${includeLabel ? `, ${labelExpr} AS label` : ""}
            FROM nodes t
           WHERE t.doco_id = $1
             AND t.node_type IN (${typeList})
             AND (t.node_type <> 'principal' OR COALESCE(t.lifecycle, 'asserted') = 'asserted')`;
}

async function loadOverviewRows(
  c: QueryClient,
  docoId: string,
  options: { centerId?: string; limit?: number } = {},
): Promise<OverviewGraphRow[]> {
  const limit = options.limit ? Math.max(1, Math.floor(options.limit)) : null;
  const params: unknown[] = [docoId];
  let limitSql = "";
  if (limit !== null) {
    params.push(limit, options.centerId ?? "");
    limitSql = "LIMIT $2";
  }
  return (
    await c.query<OverviewGraphRow>(
      `SELECT *
         FROM (${overviewRowsSql(true)}) nodes
        ORDER BY
          ${limit !== null ? "id = $3 DESC," : ""}
          CASE COALESCE(lifecycle, 'asserted')
            WHEN 'asserted' THEN 0
            WHEN 'drafting' THEN 1
            WHEN 'retired' THEN 2
            ELSE 3
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
      `SELECT from_id, to_id, edge_type
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
    source: s.from_id,
    target: s.to_id,
    edge_type: s.edge_type,
  }));
}

export async function loadOverviewGraph(
  c: QueryClient,
  docoId: string,
  options: { centerId?: string; handle?: string; limit?: number } = {},
): Promise<OverviewGraphData> {
  const rows = await loadOverviewRows(c, docoId, {
    centerId: options.centerId,
    limit: options.limit,
  });
  const nodeIds = rows.map((row) => row.id);
  const links = await loadOverviewLinks(c, docoId, nodeIds);
  const nodes: OverviewGraphNode[] = rows.map((row) => ({
    id: row.id,
    entity_type: row.entity_type,
    name: row.label ?? row.name,
    lifecycle: row.lifecycle ?? "asserted",
    created_at: toIso(row.created_at),
    href: overviewEntityHref(options.handle, row.entity_type, row.id),
    is_center: row.id === options.centerId,
  }));
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
        entity_type: row.entity_type,
        summary: row.label ?? row.name ?? row.id,
        name: row.name,
        lifecycle: row.lifecycle ?? "asserted",
        created_at: toIso(row.created_at),
        href: overviewEntityHref(handle, row.entity_type, row.id),
      },
    ];
  });
}

// ─── Org-level (cross-Doco) variants ───────────────────────────────
//
// Mirrors loadOverviewGraph but aggregates over every Doco the org
// owns. Each node carries its own Doco handle so the href points at
// the right per-Doco entity URL.

function overviewRowsSqlMulti(): string {
  // Cross-Doco variant of overviewRowsSql: same single-`nodes` query,
  // carrying doco_id and always projecting the label. Principals fall
  // back to `name` (prose='') and skip retired role-personas; the other
  // types don't filter lifecycle here. For the 9 prose types `name` is
  // NULL (only principals populate it).
  const types = [...GRAPH_TABLES.map((entry) => entry.entityType), "principal"];
  const typeList = types.map((t) => `'${t}'`).join(", ");
  const labelExpr = "COALESCE(NULLIF(split_part(t.prose, E'\n', 1), ''), t.name)";
  return `SELECT t.id,
                 t.node_type AS entity_type,
                 t.name,
                 ${labelExpr} AS label,
                 COALESCE(t.lifecycle, 'asserted') AS lifecycle,
                 t.created_at::text AS created_at,
                 t.doco_id AS doco_id
            FROM nodes t
           WHERE t.doco_id = ANY($1::text[])
             AND t.node_type IN (${typeList})
             AND (t.node_type <> 'principal' OR COALESCE(t.lifecycle, 'asserted') = 'asserted')`;
}

export async function loadOrgOverviewGraph(
  c: QueryClient,
  docoIds: string[],
  docoHandleByDocoId: Map<string, string>,
  options: { fallbackCenterId?: string } = {},
): Promise<OverviewGraphData> {
  if (docoIds.length === 0) {
    return {
      centerId: options.fallbackCenterId ?? "",
      nodes: [],
      links: [],
      detailUrl: null,
    };
  }
  const rows = (
    await c.query<OverviewGraphRow & { doco_id: string }>(overviewRowsSqlMulti(), [docoIds])
  ).rows;
  const nodeIds = rows.map((row) => row.id);
  const links =
    nodeIds.length === 0
      ? []
      : (
          await c.query<EdgeRow>(
            `SELECT from_id, to_id, edge_type
               FROM edges
              WHERE doco_id = ANY($1::text[])
                AND from_id = ANY($2::text[])
                AND to_id = ANY($2::text[])
              ORDER BY edge_type
              LIMIT $3`,
            [docoIds, nodeIds, OVERVIEW_GRAPH_EDGE_LIMIT],
          )
        ).rows.map((s) => ({
          source: s.from_id,
          target: s.to_id,
          edge_type: s.edge_type,
        }));
  const nodes: OverviewGraphNode[] = rows.map((row) => {
    const handle = docoHandleByDocoId.get(String(row.doco_id));
    return {
      id: row.id,
      entity_type: row.entity_type,
      name: row.label ?? row.name,
      lifecycle: row.lifecycle ?? "asserted",
      created_at: toIso(row.created_at),
      href: overviewEntityHref(handle, row.entity_type, row.id),
      is_center: false,
    };
  });
  return {
    centerId: nodes[0]?.id ?? options.fallbackCenterId ?? "",
    nodes,
    links,
    detailUrl: null,
  };
}
