import { type AuthoringPair, authoringEntry } from "./authoring-provenance";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface EdgeDetailRow {
  id: string;
  from_id: string;
  from_node_type: string;
  to_id: string;
  to_node_type: string;
  edge_type: string;
  props: Record<string, unknown> | null;
  lifecycle: string;
  created_at: Date | string | null;
  created_by: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
  retired_at: Date | string | null;
}

interface EdgeEndpointRow {
  id: string;
  entity_type: string;
  summary: string | null;
  name: string | null;
  lifecycle: string | null;
  created_at: Date | string | null;
}

interface EdgeVersionRow {
  version: number;
  op: string;
  recorded_at?: Date | string | null;
  actor?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
  reason?: string | null;
}

export interface EdgeDialogEndpoint {
  id: string;
  entity_type: string;
  summary: string;
  name: string | null;
  lifecycle: string;
  created_at: string | null;
  href: string;
}

export interface EdgeDialogHistoryEntry {
  version: number;
  op: string;
  recorded_at: string | null;
  actor: string | null;
  mechanism: string | null;
  reason: string | null;
}

export interface EdgeDialogDocoRef {
  handle: string;
  href: string;
}

export interface EdgeDialogDetail {
  id: string;
  edge_type: string;
  lifecycle: string;
  props: Record<string, unknown> | null;
  created_at: string | null;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
  retired_at: string | null;
  authoring: AuthoringPair;
  href: string;
  doco: EdgeDialogDocoRef;
  from: EdgeDialogEndpoint;
  to: EdgeDialogEndpoint;
  history: EdgeDialogHistoryEntry[];
}

async function resolveActorLabels(
  c: QueryClient,
  actorIds: string[],
): Promise<Map<string, string>> {
  const requested = Array.from(new Set(actorIds.filter(Boolean)));
  if (requested.length === 0) return new Map();
  const rows = (
    await c.query<{
      actor_id: string;
      label: string | null;
    }>(
      `WITH input(actor_id) AS (
         SELECT unnest($1::text[])
       )
       SELECT i.actor_id,
              COALESCE(
                NULLIF(u.data->>'name', ''),
                NULLIF(u.data->>'display_name', ''),
                u.github_login,
                u.email,
                u.id
              ) AS label
         FROM input i
         LEFT JOIN users u ON u.id = i.actor_id`,
      [requested],
    )
  ).rows;
  return new Map(
    rows
      .map((row) => [row.actor_id, row.label] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function endpointFallback(handle: string, id: string, entityType: string): EdgeDialogEndpoint {
  return {
    id,
    entity_type: entityType,
    summary: id,
    name: null,
    lifecycle: "asserted",
    created_at: null,
    href: `/${handle}/${entityType}/${id}`,
  };
}

function endpointFromRow(handle: string, row: EdgeEndpointRow): EdgeDialogEndpoint {
  return {
    id: row.id,
    entity_type: row.entity_type,
    summary: row.summary ?? row.name ?? row.id,
    name: row.name,
    lifecycle: row.lifecycle ?? "asserted",
    created_at: toIso(row.created_at),
    href: `/${handle}/${row.entity_type}/${row.id}`,
  };
}

export async function loadEdgeDialogDetail(
  c: QueryClient,
  meta: { docoId: string },
  options: { handle: string; id: string },
): Promise<EdgeDialogDetail | null> {
  const edge = (
    await c.query<EdgeDetailRow>(
      `SELECT id, from_id, from_node_type, to_id, to_node_type, edge_type,
              props, lifecycle, created_at, created_by, updated_at, updated_by, retired_at
         FROM edges
        WHERE doco_id = $1 AND id = $2`,
      [meta.docoId, options.id],
    )
  ).rows[0];
  if (!edge) return null;

  const endpointRows = (
    await c.query<EdgeEndpointRow>(
      `SELECT id,
              node_type AS entity_type,
              NULLIF(split_part(COALESCE(NULLIF(prose, ''), name, '')::text, E'\n', 1), '') AS summary,
              name,
              COALESCE(lifecycle, 'asserted') AS lifecycle,
              created_at
         FROM nodes
        WHERE doco_id = $1
          AND id = ANY($2::text[])`,
      [meta.docoId, [edge.from_id, edge.to_id]],
    )
  ).rows;
  const endpointById = new Map(
    endpointRows.map((row) => [row.id, endpointFromRow(options.handle, row)]),
  );
  const versions = (
    await c.query<EdgeVersionRow>(
      `SELECT v.version, v.op, v.recorded_at, v.actor,
              cs.source, cs.metadata, cs.reason
         FROM edge_versions v
         LEFT JOIN changesets cs ON cs.tx_id = v.tx_id
        WHERE v.entity_id = $1
        ORDER BY v.version`,
      [edge.id],
    )
  ).rows;
  const actorLabels = await resolveActorLabels(c, [
    edge.created_by ?? "",
    edge.updated_by ?? "",
    ...versions.flatMap((entry) => (entry.actor ? [entry.actor] : [])),
  ]);
  const createdVersion = versions[0];
  const updatedVersion = versions.at(-1);

  return {
    id: edge.id,
    edge_type: edge.edge_type,
    lifecycle: edge.lifecycle ?? "asserted",
    props: edge.props ?? null,
    created_at: toIso(edge.created_at),
    created_by: edge.created_by,
    updated_at: toIso(edge.updated_at),
    updated_by: edge.updated_by,
    retired_at: toIso(edge.retired_at),
    authoring: {
      created: authoringEntry({
        actor: createdVersion?.actor ?? edge.created_by,
        labels: actorLabels,
        source: createdVersion?.source ?? null,
        metadata: createdVersion?.metadata ?? null,
        at: toIso(createdVersion?.recorded_at) ?? toIso(edge.created_at),
      }),
      updated: authoringEntry({
        actor: updatedVersion?.actor ?? edge.updated_by ?? edge.created_by,
        labels: actorLabels,
        source: updatedVersion?.source ?? null,
        metadata: updatedVersion?.metadata ?? null,
        at: toIso(updatedVersion?.recorded_at) ?? toIso(edge.updated_at),
      }),
    },
    href: `/${options.handle}/edges/${edge.id}`,
    doco: {
      handle: options.handle,
      href: `/${options.handle}`,
    },
    from:
      endpointById.get(edge.from_id) ??
      endpointFallback(options.handle, edge.from_id, edge.from_node_type),
    to:
      endpointById.get(edge.to_id) ??
      endpointFallback(options.handle, edge.to_id, edge.to_node_type),
    history: versions.map((version) => ({
      version: version.version,
      op: version.op,
      recorded_at: toIso(version.recorded_at),
      actor: version.actor ?? null,
      mechanism:
        authoringEntry({
          actor: version.actor ?? null,
          labels: actorLabels,
          source: version.source ?? null,
          metadata: version.metadata ?? null,
          at: toIso(version.recorded_at),
        })?.mechanism ?? null,
      reason: version.reason ?? null,
    })),
  };
}
