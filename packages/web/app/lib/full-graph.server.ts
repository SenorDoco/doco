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
  synapse_type: string;
  attribution: string | null;
}

interface OverviewGraphRow {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
}

// Note tables only — articles (constitution metadata) are not nodes
// and are deliberately excluded from the graph. Articles have their
// own surface: /<handle>/constitution and /<handle>/api/articles.json.
const GRAPH_TABLES: {
  table: string;
  entityType: string;
  labelExpr?: string;
  nameExpr?: string;
}[] = [
  { table: "decisions", entityType: "decision" },
  { table: "intents", entityType: "intent" },
  { table: "actions", entityType: "action" },
  { table: "logs", entityType: "log" },
  { table: "rules", entityType: "rule" },
  { table: "evals", entityType: "eval" },
  { table: "reference_entities", entityType: "reference" },
  { table: "ideas", entityType: "idea" },
  { table: "states", entityType: "state" },
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
  entityType: string,
  id: string,
): string | undefined {
  if (!handle) return undefined;
  return `/${handle}/${entityType}/${id}`;
}

function overviewRowsSql(includeLabel = false): string {
  return GRAPH_TABLES.map((entry) => {
    const labelExpr = entry.labelExpr ?? "t.summary";
    const nameExpr = entry.nameExpr ?? "NULL::text";
    return `SELECT t.id,
                   '${entry.entityType}'::text AS entity_type,
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

async function loadOverviewLinks(
  c: QueryClient,
  docoId: string,
  nodeIds: string[],
): Promise<OverviewGraphLink[]> {
  if (nodeIds.length === 0) return [];
  const rows = (
    await c.query<EdgeRow>(
      `SELECT from_id, to_id, synapse_type, attribution
         FROM synapses
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND to_id = ANY($2::text[])
        ORDER BY CASE WHEN attribution = 'explicit' THEN 0 ELSE 1 END, synapse_type
        LIMIT $3`,
      [docoId, nodeIds, OVERVIEW_GRAPH_EDGE_LIMIT],
    )
  ).rows;
  return rows.map((edge) => ({
    source: edge.from_id,
    target: edge.to_id,
    synapse_type: edge.synapse_type,
    attribution: asAttribution(edge.attribution),
  }));
}

export async function loadOverviewGraph(
  c: QueryClient,
  docoId: string,
  options: { centerId?: string; handle?: string } = {},
): Promise<OverviewGraphData> {
  const rows = await loadOverviewRows(c, docoId);
  const nodeIds = rows.map((row) => row.id);
  const links = await loadOverviewLinks(c, docoId, nodeIds);
  const nodes: OverviewGraphNode[] = rows.map((row) => ({
    id: row.id,
    entity_type: row.entity_type,
    name: row.name,
    lifecycle: row.lifecycle ?? "active",
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
        lifecycle: row.lifecycle ?? "active",
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
  return GRAPH_TABLES.map(
    (entry) => `SELECT t.id,
                     '${entry.entityType}'::text AS entity_type,
                     NULL::text AS name,
                     COALESCE(t.lifecycle, 'active') AS lifecycle,
                     t.created_at::text AS created_at,
                     t.doco_id AS doco_id
                FROM ${entry.table} t
               WHERE t.doco_id = ANY($1::text[])`,
  ).join(" UNION ALL ");
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
            `SELECT from_id, to_id, synapse_type, attribution
               FROM synapses
              WHERE doco_id = ANY($1::text[])
                AND from_id = ANY($2::text[])
                AND to_id = ANY($2::text[])
              ORDER BY CASE WHEN attribution = 'explicit' THEN 0 ELSE 1 END, synapse_type
              LIMIT $3`,
            [docoIds, nodeIds, OVERVIEW_GRAPH_EDGE_LIMIT],
          )
        ).rows.map((edge) => ({
          source: edge.from_id,
          target: edge.to_id,
          synapse_type: edge.synapse_type,
          attribution: asAttribution(edge.attribution),
        }));
  const nodes: OverviewGraphNode[] = rows.map((row) => {
    const handle = docoHandleByDocoId.get(String(row.doco_id));
    return {
      id: row.id,
      entity_type: row.entity_type,
      name: row.name,
      lifecycle: row.lifecycle ?? "active",
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
