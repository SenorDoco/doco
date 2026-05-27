type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export const INDEXED_PERSPECTIVE_KINDS = ["graph", "list", "bpmn", "org-tree"] as const;

export type PerspectiveKind = (typeof INDEXED_PERSPECTIVE_KINDS)[number] | string;

export type PerspectiveLayoutStatus = "dirty" | "building" | "ready" | "failed";

export interface PerspectiveLayoutSnapshot {
  id: string;
  doco_id: string;
  perspective_kind: string;
  layout_version: number;
  status: PerspectiveLayoutStatus;
  algorithm: string;
  config_hash: string;
  bounds_min_x: number | null;
  bounds_min_y: number | null;
  bounds_max_x: number | null;
  bounds_max_y: number | null;
  stats: Record<string, unknown>;
  error: string | null;
  dirty_at: string | null;
  built_at: string | null;
  updated_at: string | null;
}

export interface PerspectiveLayoutNodeInput {
  entityId: string;
  entityType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  lodLevel?: number;
  clusterId?: string | null;
  layoutData?: Record<string, unknown>;
}

export interface PerspectiveLayoutNode {
  entity_id: string;
  entity_type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  lod_level: number;
  cluster_id: string | null;
  layout_data: Record<string, unknown>;
}

export interface PerspectiveLayoutEdgeInput {
  sourceId: string;
  targetId: string;
  synapseType: string;
  minX?: number | null;
  minY?: number | null;
  maxX?: number | null;
  maxY?: number | null;
  path?: Record<string, unknown>;
  layoutData?: Record<string, unknown>;
}

export interface PerspectiveLayoutEdge {
  source_id: string;
  target_id: string;
  synapse_type: string;
  min_x: number | null;
  min_y: number | null;
  max_x: number | null;
  max_y: number | null;
  path: Record<string, unknown>;
  layout_data: Record<string, unknown>;
}

export interface PerspectiveLayoutViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  lodLevel?: number;
  limit?: number;
}

export interface PerspectiveLayoutViewportResult {
  snapshot: PerspectiveLayoutSnapshot | null;
  nodes: PerspectiveLayoutNode[];
  edges: PerspectiveLayoutEdge[];
}

interface CountRow {
  count: number | string;
}

const MAX_CHANGED_ENTITY_IDS = 500;
const DEFAULT_VIEWPORT_LIMIT = 1000;
const MAX_VIEWPORT_LIMIT = 5000;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function coerceSnapshot(row: PerspectiveLayoutSnapshotRow): PerspectiveLayoutSnapshot {
  return {
    ...row,
    layout_version: Number(row.layout_version),
    stats: row.stats ?? {},
    dirty_at: toIso(row.dirty_at),
    built_at: toIso(row.built_at),
    updated_at: toIso(row.updated_at),
  };
}

function safePerspectiveKind(perspectiveKind: string): string {
  return (
    perspectiveKind
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "perspective"
  );
}

export function perspectiveLayoutSnapshotId(docoId: string, perspectiveKind: string): string {
  return `perspective_layout_${docoId}_${safePerspectiveKind(perspectiveKind)}`;
}

export function normalizeChangedEntityIds(ids: readonly string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))).slice(
    0,
    MAX_CHANGED_ENTITY_IDS,
  );
}

interface PerspectiveLayoutSnapshotRow
  extends Omit<
    PerspectiveLayoutSnapshot,
    "layout_version" | "dirty_at" | "built_at" | "updated_at"
  > {
  layout_version: number | string;
  dirty_at: Date | string | null;
  built_at: Date | string | null;
  updated_at: Date | string | null;
}

export async function ensurePerspectiveLayoutSnapshot(
  c: QueryClient,
  opts: {
    docoId: string;
    perspectiveKind: PerspectiveKind;
    algorithm?: string;
    configHash?: string;
  },
): Promise<PerspectiveLayoutSnapshot> {
  const perspectiveKind = String(opts.perspectiveKind);
  const id = perspectiveLayoutSnapshotId(opts.docoId, perspectiveKind);
  const row = (
    await c.query<PerspectiveLayoutSnapshotRow>(
      `INSERT INTO perspective_layout_snapshots (
         id, doco_id, perspective_kind, algorithm, config_hash, dirty_at
       )
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (doco_id, perspective_kind) DO UPDATE SET
         algorithm = CASE
           WHEN EXCLUDED.algorithm <> '' THEN EXCLUDED.algorithm
           ELSE perspective_layout_snapshots.algorithm
         END,
         config_hash = CASE
           WHEN EXCLUDED.config_hash <> '' THEN EXCLUDED.config_hash
           ELSE perspective_layout_snapshots.config_hash
         END,
         updated_at = now()
       RETURNING id, doco_id, perspective_kind, layout_version, status, algorithm, config_hash,
                 bounds_min_x, bounds_min_y, bounds_max_x, bounds_max_y,
                 stats, error, dirty_at, built_at, updated_at`,
      [id, opts.docoId, perspectiveKind, opts.algorithm ?? "", opts.configHash ?? ""],
    )
  ).rows[0];
  if (!row) throw new Error("Failed to ensure perspective layout snapshot");
  return coerceSnapshot(row);
}

export async function markPerspectiveLayoutDirty(
  c: QueryClient,
  opts: {
    docoId: string;
    perspectiveKind: PerspectiveKind;
    scopeKind?: "node" | "edge" | "lane" | "pool" | "subtree" | "viewport" | "global";
    scopeKey?: string;
    changedEntityIds?: string[];
    reason?: string;
  },
): Promise<void> {
  const changedEntityIds = normalizeChangedEntityIds(opts.changedEntityIds);
  const scopeKind = opts.scopeKind ?? (changedEntityIds.length > 0 ? "node" : "global");
  const scopeKey =
    opts.scopeKey ??
    (scopeKind === "node" && changedEntityIds.length === 1 ? changedEntityIds[0] : "*");
  const perspectiveKind = String(opts.perspectiveKind);

  await ensurePerspectiveLayoutSnapshot(c, {
    docoId: opts.docoId,
    perspectiveKind,
  });

  await c.query(
    `INSERT INTO perspective_layout_dirty_scopes (
       doco_id, perspective_kind, scope_kind, scope_key, changed_entity_ids, reason
     )
     VALUES ($1, $2, $3, $4, $5::text[], $6)
     ON CONFLICT (doco_id, perspective_kind, scope_kind, scope_key) DO UPDATE SET
       changed_entity_ids = (
         SELECT ARRAY(
           SELECT DISTINCT merged.id
             FROM unnest(
               perspective_layout_dirty_scopes.changed_entity_ids
               || EXCLUDED.changed_entity_ids
             ) AS merged(id)
            WHERE merged.id <> ''
            ORDER BY merged.id
         )
       ),
       reason = EXCLUDED.reason,
       status = 'pending',
       updated_at = now()`,
    [opts.docoId, perspectiveKind, scopeKind, scopeKey, changedEntityIds, opts.reason ?? ""],
  );

  await c.query(
    `UPDATE perspective_layout_snapshots
        SET status = 'dirty',
            layout_version = layout_version + 1,
            dirty_at = now(),
            error = NULL,
            updated_at = now()
      WHERE doco_id = $1
        AND perspective_kind = $2`,
    [opts.docoId, perspectiveKind],
  );
}

export async function markDocoPerspectiveLayoutsDirty(
  c: QueryClient,
  opts: { docoId: string; changedEntityIds?: string[]; reason?: string },
): Promise<void> {
  const changedEntityIds = normalizeChangedEntityIds(opts.changedEntityIds);
  for (const perspectiveKind of INDEXED_PERSPECTIVE_KINDS) {
    await markPerspectiveLayoutDirty(c, {
      docoId: opts.docoId,
      perspectiveKind,
      changedEntityIds,
      reason: opts.reason,
    });
  }
}

export async function upsertPerspectiveLayoutNodes(
  c: QueryClient,
  opts: {
    snapshotId: string;
    docoId: string;
    perspectiveKind: PerspectiveKind;
    nodes: PerspectiveLayoutNodeInput[];
  },
): Promise<number> {
  if (opts.nodes.length === 0) return 0;
  const rows = opts.nodes.map((node) => ({
    entity_id: node.entityId,
    entity_type: node.entityType,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    z_index: node.zIndex ?? 0,
    lod_level: node.lodLevel ?? 0,
    cluster_id: node.clusterId ?? null,
    layout_data: node.layoutData ?? {},
  }));
  const result = await c.query<CountRow>(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($4::jsonb) AS x(
           entity_id text,
           entity_type text,
           x double precision,
           y double precision,
           width double precision,
           height double precision,
           z_index integer,
           lod_level integer,
           cluster_id text,
           layout_data jsonb
         )
     ),
     upserted AS (
       INSERT INTO perspective_layout_nodes (
         snapshot_id, doco_id, perspective_kind, entity_id, entity_type,
         x, y, width, height, z_index, lod_level, cluster_id, layout_data
       )
       SELECT $1, $2, $3, entity_id, entity_type, x, y, width, height,
              COALESCE(z_index, 0), COALESCE(lod_level, 0), cluster_id,
              COALESCE(layout_data, '{}'::jsonb)
         FROM input
       ON CONFLICT (snapshot_id, entity_id) DO UPDATE SET
         entity_type = EXCLUDED.entity_type,
         x = EXCLUDED.x,
         y = EXCLUDED.y,
         width = EXCLUDED.width,
         height = EXCLUDED.height,
         z_index = EXCLUDED.z_index,
         lod_level = EXCLUDED.lod_level,
         cluster_id = EXCLUDED.cluster_id,
         layout_data = EXCLUDED.layout_data,
         updated_at = now()
       RETURNING 1
     )
     SELECT COUNT(*)::int AS count FROM upserted`,
    [opts.snapshotId, opts.docoId, String(opts.perspectiveKind), JSON.stringify(rows)],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function upsertPerspectiveLayoutEdges(
  c: QueryClient,
  opts: {
    snapshotId: string;
    docoId: string;
    perspectiveKind: PerspectiveKind;
    edges: PerspectiveLayoutEdgeInput[];
  },
): Promise<number> {
  if (opts.edges.length === 0) return 0;
  const rows = opts.edges.map((edge) => ({
    source_id: edge.sourceId,
    target_id: edge.targetId,
    synapse_type: edge.synapseType,
    min_x: edge.minX ?? null,
    min_y: edge.minY ?? null,
    max_x: edge.maxX ?? null,
    max_y: edge.maxY ?? null,
    path: edge.path ?? {},
    layout_data: edge.layoutData ?? {},
  }));
  const result = await c.query<CountRow>(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($4::jsonb) AS x(
           source_id text,
           target_id text,
           synapse_type text,
           min_x double precision,
           min_y double precision,
           max_x double precision,
           max_y double precision,
           path jsonb,
           layout_data jsonb
         )
     ),
     upserted AS (
       INSERT INTO perspective_layout_edges (
         snapshot_id, doco_id, perspective_kind, source_id, target_id, synapse_type,
         min_x, min_y, max_x, max_y, path, layout_data
       )
       SELECT $1, $2, $3, source_id, target_id, synapse_type,
              min_x, min_y, max_x, max_y,
              COALESCE(path, '{}'::jsonb),
              COALESCE(layout_data, '{}'::jsonb)
         FROM input
       ON CONFLICT (snapshot_id, source_id, target_id, synapse_type) DO UPDATE SET
         min_x = EXCLUDED.min_x,
         min_y = EXCLUDED.min_y,
         max_x = EXCLUDED.max_x,
         max_y = EXCLUDED.max_y,
         path = EXCLUDED.path,
         layout_data = EXCLUDED.layout_data,
         updated_at = now()
       RETURNING 1
     )
     SELECT COUNT(*)::int AS count FROM upserted`,
    [opts.snapshotId, opts.docoId, String(opts.perspectiveKind), JSON.stringify(rows)],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function queryPerspectiveLayoutViewport(
  c: QueryClient,
  opts: { docoId: string; perspectiveKind: PerspectiveKind } & PerspectiveLayoutViewport,
): Promise<PerspectiveLayoutViewportResult> {
  const perspectiveKind = String(opts.perspectiveKind);
  const snapshotRow = (
    await c.query<PerspectiveLayoutSnapshotRow>(
      `SELECT id, doco_id, perspective_kind, layout_version, status, algorithm, config_hash,
              bounds_min_x, bounds_min_y, bounds_max_x, bounds_max_y,
              stats, error, dirty_at, built_at, updated_at
         FROM perspective_layout_snapshots
        WHERE doco_id = $1
          AND perspective_kind = $2`,
      [opts.docoId, perspectiveKind],
    )
  ).rows[0];

  if (!snapshotRow) {
    return { snapshot: null, nodes: [], edges: [] };
  }

  const snapshot = coerceSnapshot(snapshotRow);
  const lodLevel = Math.max(0, Math.floor(opts.lodLevel ?? 0));
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_VIEWPORT_LIMIT)),
    MAX_VIEWPORT_LIMIT,
  );
  const nodes = (
    await c.query<PerspectiveLayoutNode>(
      `SELECT entity_id, entity_type, x, y, width, height,
              z_index, lod_level, cluster_id, layout_data
         FROM perspective_layout_nodes
        WHERE snapshot_id = $1
          AND lod_level <= $2
          AND x + width >= $3
          AND x <= $4
          AND y + height >= $5
          AND y <= $6
        ORDER BY z_index, entity_id
        LIMIT $7`,
      [snapshot.id, lodLevel, opts.minX, opts.maxX, opts.minY, opts.maxY, limit],
    )
  ).rows;

  if (nodes.length === 0) {
    return { snapshot, nodes: [], edges: [] };
  }

  const visibleEntityIds = nodes.map((node) => node.entity_id);
  const edges = (
    await c.query<PerspectiveLayoutEdge>(
      `SELECT source_id, target_id, synapse_type, min_x, min_y, max_x, max_y, path, layout_data
         FROM perspective_layout_edges
        WHERE snapshot_id = $1
          AND (
            (source_id = ANY($2::text[]) AND target_id = ANY($2::text[]))
            OR (
              min_x IS NOT NULL
              AND max_x IS NOT NULL
              AND min_y IS NOT NULL
              AND max_y IS NOT NULL
              AND max_x >= $3
              AND min_x <= $4
              AND max_y >= $5
              AND min_y <= $6
            )
          )
        ORDER BY source_id, target_id, synapse_type
        LIMIT $7`,
      [snapshot.id, visibleEntityIds, opts.minX, opts.maxX, opts.minY, opts.maxY, limit * 2],
    )
  ).rows;

  return { snapshot, nodes, edges };
}
