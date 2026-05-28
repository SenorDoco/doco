import { ALL_ENTITY_TABLES, DOCO_NEURON_TABLE_BY_TYPE, type DocoRole, roleAtLeast } from "@doco/db";
import { parse as parseYaml } from "yaml";
import { getDocoLevelRole } from "~/lib/doco-access.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const LIFECYCLE_STAGES = ["drafting", "proposed", "active", "retired"] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface NeuronDialogEdge {
  synapse_type: string;
  other_id: string;
  other_neuron_type: string;
  other_summary: string | null;
  other_name: string | null;
  other_lifecycle: string;
  href: string | null;
}

export interface NeuronDialogHistoryEvent {
  event_id: string;
  at: string;
  by: string | null;
  op: string;
  before: unknown;
  after: unknown;
}

export interface NeuronDialogLifecycleChange {
  at: string;
  from: string | null;
  to: string;
}

export interface NeuronDialogDocoRef {
  handle: string;
  href: string;
}

export interface NeuronLifecycleOption {
  value: LifecycleStage;
  label: string;
  current: boolean;
  disabled: boolean;
  reason: string | null;
}

export interface NeuronDialogDetail {
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
  body_md: string | null;
  doco: NeuronDialogDocoRef;
  frontmatter: Record<string, unknown>;
  raw_json: string;
  href: string;
  update_url: string | null;
  user_role: DocoRole | null;
  can_change_lifecycle: boolean;
  lifecycle_options: NeuronLifecycleOption[];
  outgoing: NeuronDialogEdge[];
  incoming: NeuronDialogEdge[];
  history: NeuronDialogHistoryEvent[];
  lifecycle_history: NeuronDialogLifecycleChange[];
}

const UPDATE_SEGMENTS: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  action: "actions",
  log: "logs",
  rule: "rules",
  eval: "evals",
  reference: "references",
  state: "states",
  idea: "ideas",
};

type GraphNeuronConfig = {
  table: string;
  typeNamedColumn: string | null;
  primaryColumn: string;
  primaryField: string;
  bodyColumn: string | null;
  bodyField: string | null;
  updateSegment: string;
};

const GRAPH_NEURON_TABLES: Record<string, GraphNeuronConfig> = {
  ...(Object.fromEntries(
    Object.entries(DOCO_NEURON_TABLE_BY_TYPE).map(([entityType, spec]) => [
      entityType,
      {
        table: spec.table,
        typeNamedColumn: ALL_ENTITY_TABLES[entityType]?.typeNamedColumn ?? entityType,
        primaryColumn: ALL_ENTITY_TABLES[entityType]?.typeNamedColumn ?? entityType,
        primaryField: ALL_ENTITY_TABLES[entityType]?.typeNamedColumn ?? entityType,
        bodyColumn: null,
        bodyField: null,
        updateSegment: UPDATE_SEGMENTS[entityType] ?? entityType,
      },
    ]),
  ) as Record<string, GraphNeuronConfig>),
  // Principal lives outside DOCO_NEURON_TABLE_SPECS (which is scoped to
  // the 9 migrated neurons) but the Graph perspective DOES render
  // Principal cards (full-graph.server.ts UNIONs a principal leg in).
  // The detail dialog must know about it too, otherwise clicking a
  // Principal card 404s with "Unknown neuron type".
  principal: {
    table: "principals",
    typeNamedColumn: null,
    primaryColumn: "name",
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
}): NeuronLifecycleOption[] {
  const current = LIFECYCLE_STAGES.includes(input.current as LifecycleStage)
    ? (input.current as LifecycleStage)
    : "active";
  const roleReason = input.role
    ? `Approver or owner role required; your role is ${input.role}.`
    : "Sign in with an approver or owner role to change lifecycle.";
  return LIFECYCLE_STAGES.map((stage) => {
    const isCurrent = stage === current;
    let reason: string | null = null;
    if (isCurrent) reason = "Current stage.";
    else if (!input.updateUrl) reason = "Lifecycle updates are not available for this neuron type.";
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

export function isGraphNeuronType(
  type: string | undefined,
): type is keyof typeof GRAPH_NEURON_TABLES {
  return Boolean(type && GRAPH_NEURON_TABLES[type]);
}

interface DialogRelatedNeuronDetail {
  id: string;
  entity_type: string;
  summary: string;
  name: string | null;
  lifecycle: string;
  href: string;
}

function relatedDetailsSql(): string {
  return Object.entries(GRAPH_NEURON_TABLES)
    .map(([entityType, cfg]) => {
      const nameExpr =
        cfg.primaryField === "name" ? `${cfg.primaryColumn}::text AS name` : "NULL::text AS name";
      return `SELECT id,
                     '${entityType}'::text AS entity_type,
                     NULLIF(split_part(${cfg.primaryColumn}::text, E'\n', 1), '') AS summary,
                     ${nameExpr},
                     COALESCE(lifecycle, 'active') AS lifecycle
                FROM ${cfg.table}
               WHERE doco_id = $1
                 AND id = ANY($2::text[])`;
    })
    .join(" UNION ALL ");
}

async function loadDialogRelatedDetails(
  c: QueryClient,
  docoId: string,
  ids: string[],
  handle: string,
): Promise<DialogRelatedNeuronDetail[]> {
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

const COLLABORATOR_METADATA_KEYS = ["created_by", "updated_by"] as const;

async function resolveCollaboratorLabelsForActorIds(
  c: QueryClient,
  docoId: string,
  actorIds: string[],
): Promise<Map<string, string>> {
  const requested = Array.from(new Set(actorIds.filter(Boolean)));
  if (requested.length === 0) return new Map();

  const rows = (
    await c.query<{
      actor_id: string;
      collaborator_id: string | null;
      label: string | null;
    }>(
      `WITH input(actor_id) AS (
         SELECT unnest($2::text[])
       ),
       resolved AS (
         SELECT i.actor_id,
                COALESCE(
                  CASE WHEN left(i.actor_id, 13) = 'collaborator_' THEN i.actor_id END,
                  CASE WHEN left(p.created_by, 13) = 'collaborator_' THEN p.created_by END,
                  CASE WHEN left(p.data->>'owner_id', 13) = 'collaborator_' THEN p.data->>'owner_id' END,
                  CASE WHEN left(p.data->>'created_by', 13) = 'collaborator_' THEN p.data->>'created_by' END
                ) AS collaborator_id
           FROM input i
           LEFT JOIN principals p ON p.doco_id = $1 AND p.id = i.actor_id
       )
       SELECT r.actor_id,
              r.collaborator_id,
              COALESCE(c.github_login, c.email, c.id) AS label
         FROM resolved r
         LEFT JOIN collaborators c ON c.id = r.collaborator_id`,
      [docoId, requested],
    )
  ).rows;

  return new Map(
    rows
      .map((row) => [row.actor_id, row.label ?? row.collaborator_id] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
}

async function resolveCollaboratorMetadata(
  c: QueryClient,
  docoId: string,
  frontmatter: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const actorIds = COLLABORATOR_METADATA_KEYS.flatMap((key) => {
    const value = frontmatter[key];
    return typeof value === "string" ? [value] : [];
  });
  if (actorIds.length === 0) return frontmatter;

  const labels = await resolveCollaboratorLabelsForActorIds(c, docoId, actorIds);
  const next = { ...frontmatter };
  for (const key of COLLABORATOR_METADATA_KEYS) {
    const value = next[key];
    if (typeof value !== "string") continue;
    const label = labels.get(value);
    if (label) next[key] = label;
    else if (value.startsWith("principal_")) next[key] = "Unknown collaborator";
  }
  return next;
}

export async function loadNeuronDialogDetail(
  c: QueryClient,
  meta: { docoId: string; ownerId: string },
  options: {
    handle: string;
    entityType: string;
    id: string;
    principalId: string | null;
  },
): Promise<NeuronDialogDetail | null> {
  const cfg = GRAPH_NEURON_TABLES[options.entityType];
  if (!cfg) return null;

  // Post-migration: the 9 migrated neurons store their primary text in
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
    }>(
      `SELECT id,
              ${cfg.primaryColumn} AS primary_text,
              ${bodySelect},
              COALESCE(lifecycle, 'active') AS lifecycle,
              data::text AS raw_json,
              created_at,
              updated_at
         FROM ${cfg.table}
        WHERE doco_id = $1 AND id = $2`,
      [meta.docoId, options.id],
    )
  ).rows[0];
  if (!row) return null;

  const frontmatter = await resolveCollaboratorMetadata(
    c,
    meta.docoId,
    parseFrontmatter(row.raw_json),
  );
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
  // neurons, this remains the type-named primary text; for Principal it
  // remains the secondary markdown body.
  const bodyMdCompat = cfg.typeNamedColumn ? (row.primary_text ?? null) : row.body_text;

  const outgoingRows = (
    await c.query<{
      to_id: string;
      to_neuron_type: string;
      synapse_type: string;
    }>(
      `SELECT to_id, to_neuron_type, synapse_type
         FROM synapses
        WHERE doco_id = $1 AND from_id = $2
        ORDER BY synapse_type, to_id`,
      [meta.docoId, row.id],
    )
  ).rows;
  const incomingRows = (
    await c.query<{
      from_id: string;
      from_neuron_type: string;
      synapse_type: string;
    }>(
      `SELECT from_id, from_neuron_type, synapse_type
         FROM synapses
        WHERE doco_id = $1 AND to_id = $2
        ORDER BY synapse_type, from_id`,
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
  const outgoing: NeuronDialogEdge[] = outgoingRows.map((edge) => {
    const detail = relatedById.get(edge.to_id);
    return {
      synapse_type: edge.synapse_type,
      other_id: edge.to_id,
      other_neuron_type: edge.to_neuron_type,
      other_summary: detail?.summary ?? null,
      other_name: detail?.name ?? null,
      other_lifecycle: detail?.lifecycle ?? "active",
      href: detail?.href ?? `/${options.handle}/${edge.to_neuron_type}/${edge.to_id}`,
    };
  });
  const incoming: NeuronDialogEdge[] = incomingRows.map((edge) => {
    const detail = relatedById.get(edge.from_id);
    return {
      synapse_type: edge.synapse_type,
      other_id: edge.from_id,
      other_neuron_type: edge.from_neuron_type,
      other_summary: detail?.summary ?? null,
      other_name: detail?.name ?? null,
      other_lifecycle: detail?.lifecycle ?? "active",
      href: detail?.href ?? `/${options.handle}/${edge.from_neuron_type}/${edge.from_id}`,
    };
  });

  const history = (
    await c.query<{
      event_id: string;
      at: Date | string;
      by_collaborator: string | null;
      op: string;
      before_json: unknown;
      after_json: unknown;
    }>(
      `SELECT event_id, at, by_collaborator, op, before_json, after_json
         FROM audit_events
        WHERE doco_id = $1 AND entity_id = $2
        ORDER BY at DESC
        LIMIT 50`,
      [meta.docoId, row.id],
    )
  ).rows.map((event) => ({
    event_id: event.event_id,
    at: toIso(event.at) ?? String(event.at),
    by: event.by_collaborator,
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
  const canChangeLifecycle = roleAtLeast(userRole, "approver");
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
    lifecycle: row.lifecycle ?? "active",
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
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
