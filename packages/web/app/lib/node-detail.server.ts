import { ALL_ENTITY_TABLES, DOCO_NODE_TABLE_BY_TYPE, type DocoRole, roleAtLeast } from "@doco/db";
import { parse as parseYaml } from "yaml";
import {
  type AuthoringActorEntry,
  type AuthoringPair,
  authoringEntry,
} from "~/lib/authoring-provenance";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { NODE_TYPE_META } from "~/lib/node-types";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const LIFECYCLE_STAGES = ["drafting", "asserted", "retired"] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface NodeDialogEdge {
  edge_type: string;
  other_id: string;
  other_node_type: string;
  other_summary: string | null;
  other_name: string | null;
  other_lifecycle: string;
  href: string | null;
}

export interface NodeDialogHistoryEvent {
  event_id: string;
  at: string;
  by: string | null;
  op: string;
  before: unknown;
  after: unknown;
}

export interface NodeDialogLifecycleChange {
  at: string;
  from: string | null;
  to: string;
}

export interface NodeDialogDocoRef {
  handle: string;
  href: string;
}

export interface NodeLifecycleOption {
  value: LifecycleStage;
  label: string;
  current: boolean;
  disabled: boolean;
  reason: string | null;
}

export interface NodeDialogDetail {
  id: string;
  entity_type: string;
  summary: string;
  name: string | null;
  primary_field: string;
  primary_text: string | null;
  body_field: string | null;
  body_text: string | null;
  lifecycle: string;
  created_at: string | null;
  updated_at: string | null;
  authoring: AuthoringPair;
  body_md: string | null;
  doco: NodeDialogDocoRef;
  frontmatter: Record<string, unknown>;
  raw_json: string;
  href: string;
  update_url: string | null;
  user_role: DocoRole | null;
  can_change_lifecycle: boolean;
  lifecycle_options: NodeLifecycleOption[];
  outgoing: NodeDialogEdge[];
  incoming: NodeDialogEdge[];
  history: NodeDialogHistoryEvent[];
  lifecycle_history: NodeDialogLifecycleChange[];
}

// Plural URL segment per node type. Derived from the shared per-type
// registry (`NODE_TYPE_META`); the `?? entityType` fallback below covers any
// type not in the registry (e.g. principal, handled by its own literal entry).
const UPDATE_SEGMENTS: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_TYPE_META).map(([type, meta]) => [type, meta.segment]),
);

type GraphNodeConfig = {
  // node_type discriminator on the unified `nodes` table.
  nodeType: string;
  // Physical `nodes` column the primary text reads from: `prose` for
  // the 9 prose types, `name` for principal.
  primaryColumn: string;
  // Logical, client-facing field name. For the 9 prose types this is
  // the old type-named field ("decision", "intent", …); "name" for
  // principal. The `=== "name"` check downstream distinguishes them.
  typeNamedColumn: string | null;
  primaryField: string;
  bodyColumn: string | null;
  bodyField: string | null;
  updateSegment: string;
};

const GRAPH_NODE_TABLES: Record<string, GraphNodeConfig> = {
  ...(Object.fromEntries(
    Object.entries(DOCO_NODE_TABLE_BY_TYPE).map(([entityType, _spec]) => {
      // Post-collapse: all 9 prose types live in `nodes` with their
      // prose in the shared `prose` column. The logical field name
      // (the old type-named column) is kept for the client-facing
      // `primary_field`.
      const typeNamedField = ALL_ENTITY_TABLES[entityType]?.typeNamedColumn ?? entityType;
      return [
        entityType,
        {
          nodeType: entityType,
          primaryColumn: "prose",
          typeNamedColumn: typeNamedField,
          primaryField: typeNamedField,
          bodyColumn: null,
          bodyField: null,
          updateSegment: UPDATE_SEGMENTS[entityType] ?? entityType,
        },
      ];
    }),
  ) as Record<string, GraphNodeConfig>),
  // Principal lives outside DOCO_NODE_TABLE_SPECS (which is scoped to
  // the 9 migrated nodes) but the Graph perspective DOES render
  // Principal cards (full-graph.server.ts UNIONs a principal leg in).
  // The detail dialog must know about it too, otherwise clicking a
  // Principal card 404s with "Unknown node type". On `nodes`, the
  // principal's display label is `name` and its prose body is `body_md`.
  principal: {
    nodeType: "principal",
    primaryColumn: "name",
    typeNamedColumn: null,
    primaryField: "name",
    bodyColumn: "body_md",
    bodyField: "body_md",
    updateSegment: "principals",
  },
};

function parseFrontmatter(rawJson: string | null | undefined): Record<string, unknown> {
  if (!rawJson) return {};
  try {
    const parsed = parseYaml(rawJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Stage labels read as state names when the option is the current
// lifecycle ("Drafting", "Proposed", "Active", "Retired") and as the
// action verb that would move into that stage when the option is one
// of the other (clickable) choices ("Draft", "Propose", "Activate",
// "Retire"). Combined with the press-down state in the UI, this makes
// the row read like "you ARE here / click to GO there."
const LIFECYCLE_VERB: Record<string, string> = {
  drafting: "draft",
  proposed: "propose",
  active: "activate",
  retired: "retire",
};

function lifecycleLabel(value: string, isCurrent: boolean): string {
  if (isCurrent) return value.replaceAll("_", " ");
  return LIFECYCLE_VERB[value] ?? value.replaceAll("_", " ");
}

function lifecycleOptions(input: {
  current: string;
  canChange: boolean;
  role: DocoRole | null;
  updateUrl: string | null;
}): NodeLifecycleOption[] {
  const current = LIFECYCLE_STAGES.includes(input.current as LifecycleStage)
    ? (input.current as LifecycleStage)
    : "asserted";
  const roleReason = input.role
    ? `Write access required to change lifecycle; your role is ${input.role}.`
    : "Sign in with write access to change lifecycle.";
  return LIFECYCLE_STAGES.map((stage) => {
    const isCurrent = stage === current;
    let reason: string | null = null;
    if (isCurrent) reason = "Current stage.";
    else if (!input.updateUrl) reason = "Lifecycle updates are not available for this node type.";
    else if (!input.canChange) reason = roleReason;
    return {
      value: stage,
      label: lifecycleLabel(stage, isCurrent),
      current: isCurrent,
      disabled: Boolean(reason),
      reason,
    };
  });
}

export function isGraphNodeType(type: string | undefined): type is keyof typeof GRAPH_NODE_TABLES {
  return Boolean(type && GRAPH_NODE_TABLES[type]);
}

interface DialogRelatedNodeDetail {
  id: string;
  entity_type: string;
  summary: string;
  name: string | null;
  lifecycle: string;
  href: string;
}

function relatedDetailsSql(): string {
  // Post-collapse: one `nodes` table. `summary` is the first line of
  // `prose` for the 9 prose types and of `name` for principal (prose='');
  // `name` is the principal's display label (NULL for the 9 types, which
  // don't populate `nodes.name`). The type list mirrors GRAPH_NODE_TABLES
  // so isGraphNodeType and this query stay in lockstep.
  const typeList = Object.values(GRAPH_NODE_TABLES)
    .map((cfg) => `'${cfg.nodeType}'`)
    .join(", ");
  return `SELECT id,
                 node_type AS entity_type,
                 NULLIF(split_part(COALESCE(NULLIF(prose, ''), name, '')::text, E'\n', 1), '') AS summary,
                 name,
                 COALESCE(lifecycle, 'asserted') AS lifecycle
            FROM nodes
           WHERE doco_id = $1
             AND id = ANY($2::text[])
             AND node_type IN (${typeList})`;
}

async function loadDialogRelatedDetails(
  c: QueryClient,
  docoId: string,
  ids: string[],
  handle: string,
): Promise<DialogRelatedNodeDetail[]> {
  const requested = Array.from(new Set(ids.filter(Boolean)));
  if (requested.length === 0) return [];
  const rows = (
    await c.query<{
      id: string;
      entity_type: string;
      summary: string | null;
      name: string | null;
      lifecycle: string | null;
    }>(relatedDetailsSql(), [docoId, requested])
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    entity_type: row.entity_type,
    summary: row.summary ?? row.name ?? row.id,
    name: row.name,
    lifecycle: row.lifecycle ?? "asserted",
    href: `/${handle}/${row.entity_type}/${row.id}`,
  }));
}

const USER_METADATA_KEYS = ["created_by", "updated_by"] as const;

async function resolveUserLabelsForActorIds(
  c: QueryClient,
  docoId: string,
  actorIds: string[],
): Promise<Map<string, string>> {
  const requested = Array.from(new Set(actorIds.filter(Boolean)));
  if (requested.length === 0) return new Map();

  const rows = (
    await c.query<{
      actor_id: string;
      user_id: string | null;
      label: string | null;
    }>(
      `WITH input(actor_id) AS (
         SELECT unnest($2::text[])
       ),
       resolved AS (
         SELECT i.actor_id,
                COALESCE(
                  CASE WHEN left(i.actor_id, 13) = 'user_' THEN i.actor_id END,
                  CASE WHEN left(p.created_by, 13) = 'user_' THEN p.created_by END
                ) AS user_id
           FROM input i
           LEFT JOIN nodes p ON p.node_type = 'principal' AND p.doco_id = $1 AND p.id = i.actor_id
       )
       SELECT r.actor_id,
              r.user_id,
              COALESCE(
                NULLIF(c.data->>'name', ''),
                NULLIF(c.data->>'display_name', ''),
                c.github_login,
                c.email,
                c.id
              ) AS label
         FROM resolved r
         LEFT JOIN users c ON c.id = r.user_id`,
      [docoId, requested],
    )
  ).rows;

  return new Map(
    rows
      .map((row) => [row.actor_id, row.label ?? row.user_id] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
}

async function resolveUserMetadata(
  c: QueryClient,
  docoId: string,
  frontmatter: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const actorIds = USER_METADATA_KEYS.flatMap((key) => {
    const value = frontmatter[key];
    return typeof value === "string" ? [value] : [];
  });
  if (actorIds.length === 0) return frontmatter;

  const labels = await resolveUserLabelsForActorIds(c, docoId, actorIds);
  const next = { ...frontmatter };
  for (const key of USER_METADATA_KEYS) {
    const value = next[key];
    if (typeof value !== "string") continue;
    const label = labels.get(value);
    if (label) next[key] = label;
    else if (value.startsWith("principal_")) next[key] = "Unknown user";
  }
  return next;
}

interface NodeAuthoringVersionRow {
  kind: "created" | "updated";
  actor: string | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  recorded_at: Date | string | null;
}

function versionAt(value: Date | string | null): string | null {
  return toIso(value) ?? (value ? String(value) : null);
}

async function loadNodeAuthoringRows(
  c: QueryClient,
  entityId: string,
): Promise<NodeAuthoringVersionRow[]> {
  return (
    await c.query<NodeAuthoringVersionRow>(
      `WITH ranked AS (
         SELECT v.actor,
                cs.source,
                cs.metadata,
                v.recorded_at,
                row_number() OVER (ORDER BY v.version ASC) AS created_rank,
                row_number() OVER (ORDER BY v.version DESC) AS updated_rank
           FROM node_versions v
           LEFT JOIN changesets cs ON cs.tx_id = v.tx_id
          WHERE v.entity_id = $1
       )
       SELECT CASE WHEN created_rank = 1 THEN 'created' ELSE 'updated' END AS kind,
              actor,
              source,
              metadata,
              recorded_at
         FROM ranked
        WHERE created_rank = 1 OR updated_rank = 1
        ORDER BY created_rank ASC`,
      [entityId],
    )
  ).rows;
}

export async function loadNodeDialogDetail(
  c: QueryClient,
  meta: { docoId: string; ownerId: string },
  options: {
    handle: string;
    entityType: string;
    id: string;
    principalId: string | null;
  },
): Promise<NodeDialogDetail | null> {
  const cfg = GRAPH_NODE_TABLES[options.entityType];
  if (!cfg) return null;

  // Post-migration: the 9 migrated nodes store their primary text in
  // a type-named column (intent/decision/...). Principal keeps a real
  // `name` display label plus optional `body_md`; keep those channels
  // distinct so the dialog does not promote the body over the label.
  const bodySelect = cfg.bodyColumn ? `${cfg.bodyColumn} AS body_text` : "NULL::text AS body_text";
  const row = (
    await c.query<{
      id: string;
      primary_text: string | null;
      body_text: string | null;
      lifecycle: string | null;
      raw_json: string;
      created_at: Date | string | null;
      updated_at: Date | string | null;
      created_by: string | null;
      updated_by: string | null;
    }>(
      `SELECT id,
              ${cfg.primaryColumn} AS primary_text,
              ${bodySelect},
              COALESCE(lifecycle, 'asserted') AS lifecycle,
              data::text AS raw_json,
              created_at,
              updated_at,
              created_by,
              updated_by
         FROM nodes
        WHERE node_type = '${cfg.nodeType}' AND doco_id = $1 AND id = $2`,
      [meta.docoId, options.id],
    )
  ).rows[0];
  if (!row) return null;

  const frontmatter = await resolveUserMetadata(c, meta.docoId, parseFrontmatter(row.raw_json));
  const authoringRows = await loadNodeAuthoringRows(c, row.id);
  const authoringActorIds = [
    row.created_by,
    row.updated_by,
    ...authoringRows.flatMap((entry) => (entry.actor ? [entry.actor] : [])),
  ].filter((value): value is string => Boolean(value));
  const authoringLabels = await resolveUserLabelsForActorIds(c, meta.docoId, authoringActorIds);
  const createdVersion = authoringRows.find((entry) => entry.kind === "created");
  const updatedVersion = authoringRows.find((entry) => entry.kind === "updated");
  const createdAuthoring: AuthoringActorEntry | null = authoringEntry({
    actor: createdVersion?.actor ?? row.created_by,
    labels: authoringLabels,
    source: createdVersion?.source ?? null,
    metadata: createdVersion?.metadata ?? null,
    at: versionAt(createdVersion?.recorded_at ?? null) ?? toIso(row.created_at),
  });
  const updatedAuthoring: AuthoringActorEntry | null = authoringEntry({
    actor: updatedVersion?.actor ?? row.updated_by ?? row.created_by,
    labels: authoringLabels,
    source: updatedVersion?.source ?? null,
    metadata: updatedVersion?.metadata ?? null,
    at: versionAt(updatedVersion?.recorded_at ?? null) ?? toIso(row.updated_at),
  });
  const name =
    (cfg.primaryField === "name" && row.primary_text ? row.primary_text : null) ??
    stringField(frontmatter, "name") ??
    stringField(frontmatter, "title") ??
    stringField(frontmatter, "locator");
  const primaryFirstLine = row.primary_text
    ? row.primary_text.split("\n")[0] || row.primary_text
    : null;
  const bodyFirstLine = row.body_text ? row.body_text.split("\n")[0] || row.body_text : null;
  const summary =
    primaryFirstLine ?? stringField(frontmatter, "summary") ?? name ?? bodyFirstLine ?? row.id;
  // Backwards-compatible field for older client code. For migrated
  // nodes, this remains the type-named primary text; for Principal it
  // remains the secondary markdown body.
  const bodyMdCompat = cfg.typeNamedColumn ? (row.primary_text ?? null) : row.body_text;

  const outgoingRows = (
    await c.query<{
      to_id: string;
      to_node_type: string;
      edge_type: string;
    }>(
      `SELECT to_id, to_node_type, edge_type
         FROM edges
        WHERE doco_id = $1 AND from_id = $2
        ORDER BY edge_type, to_id`,
      [meta.docoId, row.id],
    )
  ).rows;
  const incomingRows = (
    await c.query<{
      from_id: string;
      from_node_type: string;
      edge_type: string;
    }>(
      `SELECT from_id, from_node_type, edge_type
         FROM edges
        WHERE doco_id = $1 AND to_id = $2
        ORDER BY edge_type, from_id`,
      [meta.docoId, row.id],
    )
  ).rows;

  const relatedIds = Array.from(
    new Set([
      ...outgoingRows.map((edge) => edge.to_id),
      ...incomingRows.map((edge) => edge.from_id),
    ]),
  );
  const relatedDetails = await loadDialogRelatedDetails(c, meta.docoId, relatedIds, options.handle);
  const relatedById = new Map(relatedDetails.map((detail) => [detail.id, detail]));
  const outgoing: NodeDialogEdge[] = outgoingRows.map((edge) => {
    const detail = relatedById.get(edge.to_id);
    return {
      edge_type: edge.edge_type,
      other_id: edge.to_id,
      other_node_type: edge.to_node_type,
      other_summary: detail?.summary ?? null,
      other_name: detail?.name ?? null,
      other_lifecycle: detail?.lifecycle ?? "asserted",
      href: detail?.href ?? `/${options.handle}/${edge.to_node_type}/${edge.to_id}`,
    };
  });
  const incoming: NodeDialogEdge[] = incomingRows.map((edge) => {
    const detail = relatedById.get(edge.from_id);
    return {
      edge_type: edge.edge_type,
      other_id: edge.from_id,
      other_node_type: edge.from_node_type,
      other_summary: detail?.summary ?? null,
      other_name: detail?.name ?? null,
      other_lifecycle: detail?.lifecycle ?? "asserted",
      href: detail?.href ?? `/${options.handle}/${edge.from_node_type}/${edge.from_id}`,
    };
  });

  const history = (
    await c.query<{
      event_id: string;
      at: Date | string;
      by_user: string | null;
      op: string;
      before_json: unknown;
      after_json: unknown;
    }>(
      `SELECT event_id, at, by_user, op, before_json, after_json
         FROM audit_events
        WHERE doco_id = $1 AND entity_id = $2
        ORDER BY at DESC
        LIMIT 50`,
      [meta.docoId, row.id],
    )
  ).rows.map((event) => ({
    event_id: event.event_id,
    at: toIso(event.at) ?? String(event.at),
    by: event.by_user,
    op: event.op,
    before: event.before_json,
    after: event.after_json,
  }));

  const lifecycleHistory = history.flatMap((event) => {
    const before =
      event.before && typeof event.before === "object"
        ? (event.before as Record<string, unknown>)
        : {};
    const after =
      event.after && typeof event.after === "object"
        ? (event.after as Record<string, unknown>)
        : {};
    const from = typeof before.lifecycle === "string" ? before.lifecycle : null;
    const to = typeof after.lifecycle === "string" ? after.lifecycle : null;
    if (!to || from === to) return [];
    return [{ at: event.at, from, to }];
  });

  const userRole = await getDocoLevelRole(
    { ownerId: meta.ownerId, docoId: meta.docoId },
    options.principalId,
  );
  const canChangeLifecycle = roleAtLeast(userRole, "writer");
  const updateUrl = cfg.updateSegment
    ? `/${options.handle}/api/${cfg.updateSegment}/${row.id}.json`
    : null;

  return {
    id: row.id,
    entity_type: options.entityType,
    summary,
    name,
    primary_field: cfg.primaryField,
    primary_text: row.primary_text,
    body_field: cfg.bodyField,
    body_text: row.body_text,
    lifecycle: row.lifecycle ?? "asserted",
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    authoring: {
      created: createdAuthoring,
      updated: updatedAuthoring,
    },
    body_md: bodyMdCompat,
    doco: {
      handle: options.handle,
      href: `/${options.handle}`,
    },
    frontmatter,
    raw_json: row.raw_json,
    href: `/${options.handle}/${options.entityType}/${row.id}`,
    update_url: updateUrl,
    user_role: userRole,
    can_change_lifecycle: canChangeLifecycle,
    lifecycle_options: lifecycleOptions({
      current: row.lifecycle ?? "asserted",
      canChange: canChangeLifecycle,
      role: userRole,
      updateUrl,
    }),
    outgoing,
    incoming,
    history,
    lifecycle_history: lifecycleHistory,
  };
}
