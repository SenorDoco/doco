import { ALL_ENTITY_TABLES, DOCO_NODE_TABLE_BY_TYPE, type DocoRole, roleAtLeast } from "@doco/db";
import { parse as parseYaml } from "yaml";
import {
  type AuthoringActorEntry,
  type AuthoringPair,
  authoringEntry,
} from "~/lib/authoring-provenance";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { getGitHubRepoSlug } from "~/lib/github-connection.server";
import { NODE_TYPE_META } from "~/lib/node-types";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const LIFECYCLE_STAGES = ["drafting", "queued", "active", "retired"] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface NodeDialogEdge {
  // The edge itself — a first-class entity. Carried so each row can open the
  // edge dialog (its lifecycle, history, endpoints), not just the other node.
  edge_id: string;
  edge_type: string;
  edge_label: string | null;
  edge_lifecycle: string;
  edge_href: string;
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
  // Reference `locator` — the code/source permalink, promoted out of `data`.
  // Linked to GitHub (or the source URL) in the dialog. Null for non-references.
  locator: string | null;
  // The Doco's connected GitHub repo ("owner/name"), used to resolve a bare
  // `path:line` locator into a blob permalink. Null when no repo is connected.
  github_repo: string | null;
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
      // Post-collapse: all generic prose types live in `nodes` with their
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
  // A PR reference splits its content: the title lives in `prose` (the primary
  // text) and the PR body in `attributes.body_md` (a real body section). Without
  // this override it inherits the generic `bodyColumn: null`, hiding the body.
  reference: {
    nodeType: "reference",
    primaryColumn: "prose",
    typeNamedColumn: "reference",
    primaryField: "reference",
    bodyColumn: "attributes->>'body_md'",
    bodyField: "body_md",
    updateSegment: UPDATE_SEGMENTS.reference ?? "references",
  },
  // Principal shares the `nodes` table but reads its label/body from
  // dedicated columns rather than the generic prose column.
  principal: {
    nodeType: "principal",
    // Slim-down: principals dropped their `name`/`body_md` columns — the label
    // is `prose`, and the body folds into the `attributes` bag.
    primaryColumn: "prose",
    typeNamedColumn: null,
    primaryField: "name",
    bodyColumn: "attributes->>'body_md'",
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
// lifecycle ("Drafting", "Queued", "Active", "Retired") and as the action
// verb that would move into that stage when the option is one of the other
// (clickable) choices ("Draft", "Queue", "Activate", "Retire"). Combined
// with the press-down state in the UI, this makes the row read like
// "you ARE here / click to GO there."
const LIFECYCLE_VERB: Record<string, string> = {
  drafting: "draft",
  queued: "queue",
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
    : "active";
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

interface DialogOutgoingEdgeRow {
  edge_id: string;
  edge_lifecycle: string;
  to_id: string;
  to_node_type: string;
  edge_type: string;
  label?: string | null;
  condition?: string | null;
}

interface DialogIncomingEdgeRow {
  edge_id: string;
  edge_lifecycle: string;
  from_id: string;
  from_node_type: string;
  edge_type: string;
  label?: string | null;
  condition?: string | null;
}

function relatedDetailsSql(): string {
  // Post-collapse + slim-down: one `nodes` table, and the `name` column was
  // dropped — every type (principals included) carries its label in `prose`.
  // `summary` is the first line of `prose`; `name` is the principal's display
  // label, kept principal-only (NULL for prose types) so downstream consumers
  // see the same shape the old column had. The type list mirrors
  // GRAPH_NODE_TABLES so isGraphNodeType and this query stay in lockstep.
  const typeList = Object.values(GRAPH_NODE_TABLES)
    .map((cfg) => `'${cfg.nodeType}'`)
    .join(", ");
  return `SELECT id,
                 node_type AS entity_type,
                 NULLIF(split_part(prose, E'\n', 1), '') AS summary,
                 CASE WHEN node_type = 'principal' THEN NULLIF(prose, '') END AS name,
                 COALESCE(lifecycle, 'active') AS lifecycle
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
    lifecycle: row.lifecycle ?? "active",
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
                  CASE WHEN left(i.actor_id, 5) = 'user_' THEN i.actor_id END,
                  CASE WHEN left(p.created_by, 5) = 'user_' THEN p.created_by END
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

function sequenceFlowLabel(
  label: string | null | undefined,
  condition: string | null | undefined,
): string | null {
  const raw = label ?? condition;
  if (typeof raw !== "string") return null;
  const compact = raw.trim().replace(/\s+/g, " ");
  if (!compact) return null;
  return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function compareOutgoingEdges(a: DialogOutgoingEdgeRow, b: DialogOutgoingEdgeRow): number {
  return a.edge_type.localeCompare(b.edge_type) || a.to_id.localeCompare(b.to_id);
}

function compareIncomingEdges(a: DialogIncomingEdgeRow, b: DialogIncomingEdgeRow): number {
  return a.edge_type.localeCompare(b.edge_type) || a.from_id.localeCompare(b.from_id);
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

  // The 9 prose nodes store their primary text in a type-named column
  // (intent/decision/...). Principal keeps a real `name` display label
  // plus optional `body_md`; keep those channels distinct so the dialog
  // does not promote the body over the label.
  const bodySelect = cfg.bodyColumn ? `${cfg.bodyColumn} AS body_text` : "NULL::text AS body_text";
  const row = (
    await c.query<{
      id: string;
      primary_text: string | null;
      body_text: string | null;
      lifecycle: string | null;
      raw_json: string;
      locator: string | null;
      created_at: Date | string | null;
      updated_at: Date | string | null;
      created_by: string | null;
      updated_by: string | null;
    }>(
      `SELECT id,
              ${cfg.primaryColumn} AS primary_text,
              ${bodySelect},
              COALESCE(lifecycle, 'active') AS lifecycle,
              attributes::text AS raw_json,
              attributes->>'locator' AS locator,
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
  // Backwards-compatible field for older client code. Prefer a real body
  // section when the node has one (Principal's `attributes.body_md`; a PR
  // Reference's split-out body). For migrated prose nodes with no body section
  // (decision/intent/…), fall back to the type-named primary text (the prose).
  const bodyMdCompat = row.body_text ?? (cfg.typeNamedColumn ? row.primary_text : null);

  const outgoingRows = (
    await c.query<DialogOutgoingEdgeRow>(
      `SELECT id AS edge_id, COALESCE(lifecycle, 'active') AS edge_lifecycle,
              to_id, to_node_type, edge_type, label, condition
         FROM edges
        WHERE doco_id = $1 AND from_id = $2
        ORDER BY edge_type, to_id`,
      [meta.docoId, row.id],
    )
  ).rows;
  const incomingRows = (
    await c.query<DialogIncomingEdgeRow>(
      `SELECT id AS edge_id, COALESCE(lifecycle, 'active') AS edge_lifecycle,
              from_id, from_node_type, edge_type, label, condition
         FROM edges
        WHERE doco_id = $1 AND to_id = $2
        ORDER BY edge_type, from_id`,
      [meta.docoId, row.id],
    )
  ).rows;
  const allOutgoingRows = [...outgoingRows].sort(compareOutgoingEdges);
  const allIncomingRows = [...incomingRows].sort(compareIncomingEdges);

  const relatedIds = Array.from(
    new Set([
      ...allOutgoingRows.map((edge) => edge.to_id),
      ...allIncomingRows.map((edge) => edge.from_id),
    ]),
  );
  const relatedDetails = await loadDialogRelatedDetails(c, meta.docoId, relatedIds, options.handle);
  const relatedById = new Map(relatedDetails.map((detail) => [detail.id, detail]));
  const outgoing: NodeDialogEdge[] = allOutgoingRows.map((edge) => {
    const detail = relatedById.get(edge.to_id);
    const otherNodeType = detail?.entity_type ?? edge.to_node_type;
    return {
      edge_id: edge.edge_id,
      edge_type: edge.edge_type,
      edge_label: sequenceFlowLabel(edge.label, edge.condition),
      edge_lifecycle: edge.edge_lifecycle ?? "active",
      edge_href: `/${options.handle}/edges/${edge.edge_id}`,
      other_id: edge.to_id,
      other_node_type: otherNodeType,
      other_summary: detail?.summary ?? null,
      other_name: detail?.name ?? null,
      other_lifecycle: detail?.lifecycle ?? "active",
      href: detail?.href ?? `/${options.handle}/${otherNodeType}/${edge.to_id}`,
    };
  });
  const incoming: NodeDialogEdge[] = allIncomingRows.map((edge) => {
    const detail = relatedById.get(edge.from_id);
    const otherNodeType = detail?.entity_type ?? edge.from_node_type;
    return {
      edge_id: edge.edge_id,
      edge_type: edge.edge_type,
      edge_label: sequenceFlowLabel(edge.label, edge.condition),
      edge_lifecycle: edge.edge_lifecycle ?? "active",
      edge_href: `/${options.handle}/edges/${edge.edge_id}`,
      other_id: edge.from_id,
      other_node_type: otherNodeType,
      other_summary: detail?.summary ?? null,
      other_name: detail?.name ?? null,
      other_lifecycle: detail?.lifecycle ?? "active",
      href: detail?.href ?? `/${options.handle}/${otherNodeType}/${edge.from_id}`,
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
  const githubRepo = await getGitHubRepoSlug(c, meta.docoId);

  return {
    id: row.id,
    entity_type: options.entityType,
    summary,
    name,
    primary_field: cfg.primaryField,
    primary_text: row.primary_text,
    body_field: cfg.bodyField,
    body_text: row.body_text,
    lifecycle: row.lifecycle ?? "active",
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    authoring: {
      created: createdAuthoring,
      updated: updatedAuthoring,
    },
    body_md: bodyMdCompat,
    locator: row.locator ?? null,
    github_repo: githubRepo,
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
      current: row.lifecycle ?? "active",
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
