import { globalPageRank } from "@doco/index";
import { parse as parseYaml } from "yaml";
import type { GraphLink, GraphNode } from "~/components/entity-graph";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface GraphRow {
  id: string;
  node_type: string;
  label: string | null;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  created_by: string | null;
  raw_yaml: string | null;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  attribution: string | null;
}

export interface FullGraphData {
  centerId: string;
  nodes: GraphNode[];
  links: GraphLink[];
  scopeFilters: { id: string; name: string; icon: string | null }[];
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
  { table: "evals", nodeType: "eval" },
  { table: "reference_entities", nodeType: "reference" },
  { table: "ideas", nodeType: "idea" },
  { table: "states", nodeType: "state" },
  {
    table: "scopes",
    nodeType: "scope",
    labelExpr: "COALESCE(NULLIF(t.purpose, ''), t.name)",
    nameExpr: "t.name",
  },
];

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

function stringField(fm: Record<string, unknown>, field: string): string | null {
  const value = fm[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function graphLanePrincipalId(
  nodeType: string,
  fm: Record<string, unknown>,
  createdBy: string | null,
): string | null {
  if (nodeType === "intent") return stringField(fm, "wanted_by") ?? createdBy;
  if (nodeType === "action" || nodeType === "log") return stringField(fm, "actor_id") ?? createdBy;
  if (nodeType === "decision") return stringField(fm, "decided_by") ?? createdBy;
  return createdBy;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asAttribution(value: string | null): "explicit" | "doco-auto" {
  return value === "doco-auto" ? "doco-auto" : "explicit";
}

async function loadGraphRows(
  c: QueryClient,
  docoId: string,
  scopeId?: string,
): Promise<GraphRow[]> {
  const unionSql = GRAPH_TABLES.map((entry) => {
    const labelExpr = entry.labelExpr ?? "t.summary";
    const nameExpr = entry.nameExpr ?? "NULL::text";
    const scopeClause = scopeId
      ? entry.nodeType === "scope"
        ? `AND (
             t.id = $2
             OR EXISTS (
               SELECT 1 FROM edges se
                WHERE se.doco_id = t.doco_id
                  AND se.from_id = t.id
                  AND se.edge_type = 'in_scope_of'
                  AND se.to_id = $2
             )
           )`
        : `AND EXISTS (
             SELECT 1 FROM edges se
              WHERE se.doco_id = t.doco_id
                AND se.from_id = t.id
                AND se.edge_type = 'in_scope_of'
                AND se.to_id = $2
           )`
      : "";
    return `SELECT t.id,
                   '${entry.nodeType}'::text AS node_type,
                   ${labelExpr} AS label,
                   ${nameExpr} AS name,
                   COALESCE(t.lifecycle, 'active') AS lifecycle,
                   t.created_at::text AS created_at,
                   t.created_by,
                   t.raw_yaml
              FROM ${entry.table} t
             WHERE t.doco_id = $1
             ${scopeClause}`;
  }).join(" UNION ALL ");
  const params = scopeId ? [docoId, scopeId] : [docoId];
  return (await c.query<GraphRow>(unionSql, params)).rows;
}

export async function loadFullGraph(
  c: QueryClient,
  docoId: string,
  options: { scopeId?: string; centerId?: string } = {},
): Promise<FullGraphData> {
  const rows = await loadGraphRows(c, docoId, options.scopeId);
  const nodeIds = new Set(rows.map((row) => row.id));

  const allEdges = (
    await c.query<EdgeRow>(
      "SELECT from_id, to_id, edge_type, attribution FROM edges WHERE doco_id = $1",
      [docoId],
    )
  ).rows;
  const graphEdges = allEdges.filter(
    (edge) => nodeIds.has(edge.from_id) && nodeIds.has(edge.to_id),
  );
  const rankEdges = allEdges.map((edge) => ({
    from: edge.from_id,
    to: edge.to_id,
    edge_type: edge.edge_type,
    attribution: asAttribution(edge.attribution),
  }));
  const gpr = globalPageRank(rankEdges, { alpha: 0.85 });
  const gprById = new Map(gpr.map((rank) => [rank.id, rank.score]));

  const principalIdByNode = new Map<string, string | null>();
  const principalIds = new Set<string>();
  for (const row of rows) {
    const principalId = graphLanePrincipalId(
      row.node_type,
      storedFrontmatter(row.raw_yaml),
      row.created_by,
    );
    principalIdByNode.set(row.id, principalId);
    if (principalId) principalIds.add(principalId);
  }
  const principalLabelById = new Map<string, string>();
  if (principalIds.size > 0) {
    const principalRows = (
      await c.query<{ id: string; label: string }>(
        "SELECT id, username AS label FROM principals WHERE id = ANY($1::text[])",
        [Array.from(principalIds)],
      )
    ).rows;
    for (const row of principalRows) principalLabelById.set(row.id, row.label);
  }

  const scopeIdsByNode = new Map<string, Set<string>>();
  const scopeIds = new Set<string>();
  for (const row of rows) {
    if (row.node_type === "scope") scopeIds.add(row.id);
  }
  for (const edge of allEdges) {
    if (edge.edge_type !== "in_scope_of") continue;
    if (!nodeIds.has(edge.from_id)) continue;
    if (!edge.to_id.startsWith("scope_")) continue;
    const ids = scopeIdsByNode.get(edge.from_id) ?? new Set<string>();
    ids.add(edge.to_id);
    scopeIdsByNode.set(edge.from_id, ids);
    scopeIds.add(edge.to_id);
  }

  const scopeById = new Map<string, { id: string; name: string; icon: string | null }>();
  if (scopeIds.size > 0) {
    const scopeRows = (
      await c.query<{ id: string; name: string; raw_yaml: string }>(
        "SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1 AND id = ANY($2::text[])",
        [docoId, Array.from(scopeIds)],
      )
    ).rows;
    for (const scope of scopeRows) {
      let icon: string | null = null;
      try {
        const parsed = parseYaml(scope.raw_yaml) as { icon?: string } | null;
        if (parsed && typeof parsed.icon === "string") icon = parsed.icon;
      } catch {}
      scopeById.set(scope.id, { id: scope.id, name: scope.name, icon });
    }
  }

  const lifecycleSinceById = new Map<string, string>();
  if (nodeIds.size > 0) {
    const auditRows = (
      await c.query<{
        entity_id: string;
        at: Date | string;
        before_json: unknown;
        after_json: unknown;
      }>(
        `SELECT entity_id, at, before_json, after_json
           FROM audit_events
          WHERE doco_id = $1 AND entity_id = ANY($2::text[])
          ORDER BY at DESC`,
        [docoId, Array.from(nodeIds)],
      )
    ).rows;
    for (const row of auditRows) {
      const before = (row.before_json ?? {}) as { lifecycle?: unknown };
      const after = (row.after_json ?? {}) as { lifecycle?: unknown };
      const beforeLifecycle = typeof before.lifecycle === "string" ? before.lifecycle : null;
      const afterLifecycle = typeof after.lifecycle === "string" ? after.lifecycle : null;
      if (!afterLifecycle || beforeLifecycle === afterLifecycle) continue;
      if (!lifecycleSinceById.has(row.entity_id)) {
        lifecycleSinceById.set(row.entity_id, toIso(row.at) ?? String(row.at));
      }
    }
  }

  const nodes: GraphNode[] = rows.map((row) => {
    const principalId = principalIdByNode.get(row.id) ?? null;
    return {
      id: row.id,
      node_type: row.node_type,
      summary: row.label ?? row.id,
      name: row.name,
      lifecycle: row.lifecycle,
      scopes: Array.from(scopeIdsByNode.get(row.id) ?? [])
        .map((scopeId) => scopeById.get(scopeId))
        .filter((scope): scope is { id: string; name: string; icon: string | null } =>
          Boolean(scope),
        ),
      principal_id: principalId,
      principal_label: principalId ? (principalLabelById.get(principalId) ?? null) : null,
      created_at: toIso(row.created_at),
      lifecycle_since: lifecycleSinceById.get(row.id) ?? toIso(row.created_at),
      ppr: 0,
      gpr: gprById.get(row.id) ?? 0,
      is_center: false,
    };
  });

  const centerId =
    (options.centerId && nodeIds.has(options.centerId) ? options.centerId : null) ??
    (options.scopeId && nodeIds.has(options.scopeId) ? options.scopeId : null) ??
    nodes.slice().sort((a, b) => b.gpr - a.gpr)[0]?.id ??
    nodes[0]?.id ??
    options.centerId ??
    options.scopeId ??
    docoId;

  return {
    centerId,
    nodes,
    links: graphEdges.map((edge) => ({
      source: edge.from_id,
      target: edge.to_id,
      edge_type: edge.edge_type,
      attribution: asAttribution(edge.attribution),
    })),
    scopeFilters: Array.from(scopeById.values()).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
