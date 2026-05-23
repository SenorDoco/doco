import { DOCO_NEURON_TABLE_SPECS } from "@doco/db";
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
}

interface OverviewGraphRow {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
}

// Note tables only — primitives are not
// neurons and are deliberately excluded from the graph. Primitives
// have their own surface: /<handle>/primitives and
// /<handle>/api/primitives.json.
const GRAPH_TABLES = DOCO_NEURON_TABLE_SPECS;

const OVERVIEW_GRAPH_SYNAPSE_LIMIT = 5000;
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
  const neuronLegs = GRAPH_TABLES.map((entry) => {
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
  });
  // Principals are Doco-scoped (migration 020); filter by the typed
  // column and drop retired role-personas.
  const principalLeg = `SELECT id,
                                'principal'::text AS entity_type,
                                username AS name,
                                COALESCE(lifecycle, 'active') AS lifecycle,
                                created_at::text AS created_at
                                ${includeLabel ? ", COALESCE(summary, username) AS label" : ""}
                           FROM principals
                          WHERE doco_id = $1
                            AND COALESCE(lifecycle, 'active') = 'active'`;
  return [...neuronLegs, principalLeg].join(" UNION ALL ");
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
      `SELECT from_id, to_id, synapse_type
         FROM synapses
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND to_id = ANY($2::text[])
        ORDER BY synapse_type
        LIMIT $3`,
      [docoId, nodeIds, OVERVIEW_GRAPH_SYNAPSE_LIMIT],
    )
  ).rows;
  return rows.map((s) => ({
    source: s.from_id,
    target: s.to_id,
    synapse_type: s.synapse_type,
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
    detailUrl: options.handle ? `/${options.handle}/graph-neuron-details.json` : null,
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
  const neuronLegs = GRAPH_TABLES.map(
    (entry) => `SELECT t.id,
                     '${entry.entityType}'::text AS entity_type,
                     NULL::text AS name,
                     COALESCE(t.lifecycle, 'active') AS lifecycle,
                     t.created_at::text AS created_at,
                     t.doco_id AS doco_id
                FROM ${entry.table} t
               WHERE t.doco_id = ANY($1::text[])`,
  );
  const principalLeg = `SELECT id,
                              'principal'::text AS entity_type,
                              username AS name,
                              COALESCE(lifecycle, 'active') AS lifecycle,
                              created_at::text AS created_at,
                              doco_id AS doco_id
                         FROM principals
                        WHERE doco_id = ANY($1::text[])
                          AND COALESCE(lifecycle, 'active') = 'active'`;
  return [...neuronLegs, principalLeg].join(" UNION ALL ");
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
            `SELECT from_id, to_id, synapse_type
               FROM synapses
              WHERE doco_id = ANY($1::text[])
                AND from_id = ANY($2::text[])
                AND to_id = ANY($2::text[])
              ORDER BY synapse_type
              LIMIT $3`,
            [docoIds, nodeIds, OVERVIEW_GRAPH_SYNAPSE_LIMIT],
          )
        ).rows.map((s) => ({
          source: s.from_id,
          target: s.to_id,
          synapse_type: s.synapse_type,
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
