import { globalPageRank } from "@doco/index";
import { parse as parseYaml } from "yaml";
import type { GraphLink, GraphNode } from "~/components/entity-graph";
import { nodeTypePlural } from "~/lib/node-colors";

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

interface OverviewScopeRow {
  id: string;
  name: string;
  purpose: string | null;
  lifecycle: string | null;
  raw_yaml: string | null;
  created_at: string | null;
}

interface OverviewClusterRow {
  scope_id: string | null;
  scope_name: string | null;
  node_type: string;
  lifecycle: string;
  node_count: string;
  latest_at: string | null;
}

interface OverviewClusterEdgeRow {
  source_cluster_id: string;
  target_cluster_id: string;
  edge_type: string;
  attribution: string | null;
  edge_count: string;
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

const OVERVIEW_GRAPH_EDGE_LIMIT = 900;
const UNSCOPED_CLUSTER_KEY = "unscoped";

const OVERVIEW_ENTITY_TABLES = GRAPH_TABLES.filter((entry) => entry.nodeType !== "scope");

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

function overviewEntitiesSql(): string {
  return OVERVIEW_ENTITY_TABLES.map((entry) => {
    const labelExpr = entry.labelExpr ?? "t.summary";
    const nameExpr = entry.nameExpr ?? "NULL::text";
    return `SELECT t.id,
                   '${entry.nodeType}'::text AS node_type,
                   COALESCE(t.lifecycle, 'active') AS lifecycle,
                   t.created_at,
                   ${labelExpr} AS label,
                   ${nameExpr} AS name
              FROM ${entry.table} t
             WHERE t.doco_id = $1`;
  }).join(" UNION ALL ");
}

function scopeIcon(rawYaml: string | null | undefined): string | null {
  const parsed = storedFrontmatter(rawYaml);
  return typeof parsed.icon === "string" ? parsed.icon : null;
}

function clusterId(scopeId: string | null, nodeType: string, lifecycle: string): string {
  return `cluster:${scopeId ?? UNSCOPED_CLUSTER_KEY}:${nodeType}:${lifecycle}`;
}

function clusterSearchHref(
  handle: string | undefined,
  args: { scopeName: string | null; nodeType: string; lifecycle: string },
): string | undefined {
  if (!handle) return undefined;
  const params = new URLSearchParams();
  params.set("node_type", args.nodeType);
  params.set("lifecycle", args.lifecycle);
  if (args.scopeName) params.set("scope", args.scopeName);
  return `/${handle}/search?${params.toString()}`;
}

function docoHref(handle: string | undefined): string | undefined {
  return handle ? `/${handle}` : undefined;
}

async function loadOverviewScopes(
  c: QueryClient,
  docoId: string,
  scopeId?: string,
): Promise<OverviewScopeRow[]> {
  const where = scopeId ? "doco_id = $1 AND id = $2" : "doco_id = $1";
  const params = scopeId ? [docoId, scopeId] : [docoId];
  return (
    await c.query<OverviewScopeRow>(
      `SELECT id,
              name,
              purpose,
              COALESCE(lifecycle, 'active') AS lifecycle,
              raw_yaml,
              created_at::text AS created_at
         FROM scopes
        WHERE ${where}
        ORDER BY name`,
      params,
    )
  ).rows;
}

async function loadOverviewClusters(
  c: QueryClient,
  docoId: string,
  scopeId?: string,
): Promise<OverviewClusterRow[]> {
  const scopeFilter = scopeId ? "WHERE m.scope_id = $2" : "";
  const params = scopeId ? [docoId, scopeId] : [docoId];
  return (
    await c.query<OverviewClusterRow>(
      `WITH entities AS (${overviewEntitiesSql()}),
            memberships AS (
              SELECT e.id,
                     e.node_type,
                     e.lifecycle,
                     e.created_at,
                     s.id AS scope_id,
                     s.name AS scope_name
                FROM entities e
                LEFT JOIN edges se
                  ON se.doco_id = $1
                 AND se.from_id = e.id
                 AND se.edge_type = 'in_scope_of'
                LEFT JOIN scopes s
                  ON s.doco_id = $1
                 AND s.id = se.to_id
            )
       SELECT m.scope_id,
              m.scope_name,
              m.node_type,
              m.lifecycle,
              COUNT(*)::text AS node_count,
              MAX(m.created_at)::text AS latest_at
         FROM memberships m
         ${scopeFilter}
        GROUP BY m.scope_id, m.scope_name, m.node_type, m.lifecycle
        ORDER BY COUNT(*) DESC, m.scope_name NULLS LAST, m.node_type, m.lifecycle`,
      params,
    )
  ).rows;
}

async function loadOverviewClusterEdges(
  c: QueryClient,
  docoId: string,
  scopeId?: string,
): Promise<OverviewClusterEdgeRow[]> {
  const scopeFilter = scopeId ? "WHERE s.id = $2" : "";
  const params = scopeId
    ? [docoId, scopeId, OVERVIEW_GRAPH_EDGE_LIMIT]
    : [docoId, OVERVIEW_GRAPH_EDGE_LIMIT];
  const limitParam = scopeId ? "$3" : "$2";
  return (
    await c.query<OverviewClusterEdgeRow>(
      `WITH entities AS (${overviewEntitiesSql()}),
            entity_clusters AS (
              SELECT e.id,
                     ('cluster:' || COALESCE(s.id, '${UNSCOPED_CLUSTER_KEY}') || ':' || e.node_type || ':' || e.lifecycle) AS cluster_id,
                     s.id AS scope_id
                FROM entities e
                LEFT JOIN edges se
                  ON se.doco_id = $1
                 AND se.from_id = e.id
                 AND se.edge_type = 'in_scope_of'
                LEFT JOIN scopes s
                  ON s.doco_id = $1
                 AND s.id = se.to_id
              ${scopeFilter}
            )
       SELECT sc.cluster_id AS source_cluster_id,
              tc.cluster_id AS target_cluster_id,
              e.edge_type,
              e.attribution,
              COUNT(*)::text AS edge_count
         FROM edges e
         JOIN entity_clusters sc ON sc.id = e.from_id
         JOIN entity_clusters tc ON tc.id = e.to_id
        WHERE e.doco_id = $1
          AND e.edge_type != 'in_scope_of'
          AND sc.cluster_id != tc.cluster_id
        GROUP BY sc.cluster_id, tc.cluster_id, e.edge_type, e.attribution
        ORDER BY COUNT(*) DESC
        LIMIT ${limitParam}`,
      params,
    )
  ).rows;
}

export async function loadOverviewGraph(
  c: QueryClient,
  docoId: string,
  options: { scopeId?: string; centerId?: string; handle?: string } = {},
): Promise<FullGraphData> {
  const [scopeRows, clusterRows, clusterEdgeRows] = await Promise.all([
    loadOverviewScopes(c, docoId, options.scopeId),
    loadOverviewClusters(c, docoId, options.scopeId),
    loadOverviewClusterEdges(c, docoId, options.scopeId),
  ]);

  const scopeById = new Map(
    scopeRows.map((scope) => [
      scope.id,
      {
        id: scope.id,
        name: scope.name,
        icon: scopeIcon(scope.raw_yaml),
        purpose: scope.purpose,
        lifecycle: scope.lifecycle ?? "active",
        created_at: toIso(scope.created_at),
      },
    ]),
  );
  const countByScope = new Map<string, number>();
  let totalCount = 0;
  for (const row of clusterRows) {
    const count = Number(row.node_count);
    totalCount += count;
    if (row.scope_id) countByScope.set(row.scope_id, (countByScope.get(row.scope_id) ?? 0) + count);
  }

  const docoNodeId = `doco:${docoId}`;
  const scopeNodes: GraphNode[] = scopeRows.map((scope) => {
    const count = countByScope.get(scope.id) ?? 0;
    return {
      id: scope.id,
      node_type: "scope",
      summary: `${count.toLocaleString()} nodes in ${scope.name}`,
      name: scope.name,
      href: options.handle ? `/${options.handle}/scopes/${scope.id}` : undefined,
      count,
      lifecycle: scope.lifecycle ?? "active",
      scopes: [],
      principal_id: null,
      principal_label: null,
      created_at: toIso(scope.created_at),
      lifecycle_since: toIso(scope.created_at),
      ppr: 0,
      gpr: count,
      is_center: scope.id === options.centerId || scope.id === options.scopeId,
    };
  });

  const clusterNodes: GraphNode[] = clusterRows.map((row) => {
    const count = Number(row.node_count);
    const scope = row.scope_id ? scopeById.get(row.scope_id) : null;
    const labelScope = scope?.name ?? "Unscoped";
    const plural = nodeTypePlural(row.node_type);
    return {
      id: clusterId(row.scope_id, row.node_type, row.lifecycle),
      node_type: row.node_type,
      summary: `${count.toLocaleString()} ${plural} · ${row.lifecycle}`,
      name: `${labelScope} · ${plural}`,
      href: clusterSearchHref(options.handle, {
        scopeName: scope?.name ?? null,
        nodeType: row.node_type,
        lifecycle: row.lifecycle,
      }),
      count,
      lifecycle: row.lifecycle,
      scopes: scope
        ? [{ id: scope.id, name: scope.name, icon: scope.icon }]
        : [{ id: UNSCOPED_CLUSTER_KEY, name: "Unscoped", icon: null }],
      principal_id: null,
      principal_label: null,
      created_at: toIso(row.latest_at),
      lifecycle_since: toIso(row.latest_at),
      ppr: 0,
      gpr: count,
      is_center: false,
    };
  });

  const nodes: GraphNode[] = [];
  if (!options.scopeId) {
    nodes.push({
      id: docoNodeId,
      node_type: "doco",
      summary: `${totalCount.toLocaleString()} nodes · ${scopeRows.length.toLocaleString()} scopes`,
      name: "Doco",
      href: docoHref(options.handle),
      count: totalCount,
      lifecycle: "active",
      scopes: [],
      principal_id: null,
      principal_label: null,
      created_at: null,
      lifecycle_since: null,
      ppr: 0,
      gpr: totalCount,
      is_center: true,
    });
  }
  nodes.push(...scopeNodes, ...clusterNodes);

  const links: GraphLink[] = [];
  if (!options.scopeId) {
    for (const scope of scopeRows) {
      const count = countByScope.get(scope.id) ?? 0;
      links.push({
        source: docoNodeId,
        target: scope.id,
        edge_type: `${count.toLocaleString()} nodes`,
        attribution: "explicit",
      });
    }
  }
  for (const row of clusterRows) {
    if (!row.scope_id) continue;
    links.push({
      source: row.scope_id,
      target: clusterId(row.scope_id, row.node_type, row.lifecycle),
      edge_type: `${Number(row.node_count).toLocaleString()} ${nodeTypePlural(row.node_type)}`,
      attribution: "explicit",
    });
  }
  for (const row of clusterEdgeRows) {
    links.push({
      source: row.source_cluster_id,
      target: row.target_cluster_id,
      edge_type: `${row.edge_type} ×${Number(row.edge_count).toLocaleString()}`,
      attribution: asAttribution(row.attribution),
    });
  }

  const centerId =
    (options.centerId && nodes.some((node) => node.id === options.centerId)
      ? options.centerId
      : null) ??
    (options.scopeId && nodes.some((node) => node.id === options.scopeId)
      ? options.scopeId
      : null) ??
    (nodes.some((node) => node.id === docoNodeId) ? docoNodeId : null) ??
    nodes[0]?.id ??
    options.centerId ??
    docoId;

  return {
    centerId,
    nodes,
    links,
    scopeFilters: scopeRows.map((scope) => ({
      id: scope.id,
      name: scope.name,
      icon: scopeIcon(scope.raw_yaml),
    })),
  };
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
