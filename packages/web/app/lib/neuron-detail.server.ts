import { type DocoRole, roleAtLeast } from "@doco/db";
import { parse as parseYaml } from "yaml";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { loadOverviewNodeDetails } from "~/lib/full-graph.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const LIFECYCLE_STAGES = ["drafted", "proposed", "active", "retired"] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface NeuronDialogEdge {
  synapse_type: string;
  other_id: string;
  other_neuron_type: string;
  other_summary: string | null;
  other_name: string | null;
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
  lifecycle: string;
  created_at: string | null;
  updated_at: string | null;
  body_md: string | null;
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

const GRAPH_NEURON_TABLES: Record<
  string,
  {
    table: string;
    hasBody: boolean;
    updateSegment: string | null;
  }
> = {
  decision: { table: "decisions", hasBody: true, updateSegment: "decisions" },
  intent: { table: "intents", hasBody: true, updateSegment: "intents" },
  action: { table: "actions", hasBody: true, updateSegment: "actions" },
  log: { table: "logs", hasBody: true, updateSegment: "logs" },
  rule: { table: "rules", hasBody: true, updateSegment: "rules" },
  eval: { table: "evals", hasBody: true, updateSegment: "evals" },
  reference: { table: "reference_entities", hasBody: false, updateSegment: "references" },
  state: { table: "states", hasBody: true, updateSegment: "states" },
  idea: { table: "ideas", hasBody: true, updateSegment: null },
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

function lifecycleLabel(value: string): string {
  return value.replaceAll("_", " ");
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
      label: lifecycleLabel(stage),
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

  const row = (
    await c.query<{
      id: string;
      summary: string | null;
      lifecycle: string | null;
      body_md: string | null;
      raw_json: string;
      created_at: Date | string | null;
      updated_at: Date | string | null;
    }>(
      `SELECT id,
              summary,
              COALESCE(lifecycle, 'active') AS lifecycle,
              ${cfg.hasBody ? "body_md" : "NULL::text AS body_md"},
              data::text AS raw_json,
              created_at,
              updated_at
         FROM ${cfg.table}
        WHERE doco_id = $1 AND id = $2`,
      [meta.docoId, options.id],
    )
  ).rows[0];
  if (!row) return null;

  const frontmatter = parseFrontmatter(row.raw_json);
  const name =
    stringField(frontmatter, "name") ??
    stringField(frontmatter, "title") ??
    stringField(frontmatter, "locator");
  const summary = row.summary ?? stringField(frontmatter, "summary") ?? name ?? row.id;

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
  const relatedDetails = await loadOverviewNodeDetails(c, meta.docoId, relatedIds, options.handle);
  const relatedById = new Map(relatedDetails.map((detail) => [detail.id, detail]));
  const outgoing: NeuronDialogEdge[] = outgoingRows.map((edge) => {
    const detail = relatedById.get(edge.to_id);
    return {
      synapse_type: edge.synapse_type,
      other_id: edge.to_id,
      other_neuron_type: edge.to_neuron_type,
      other_summary: detail?.summary ?? null,
      other_name: detail?.name ?? null,
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
    lifecycle: row.lifecycle ?? "active",
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    body_md: row.body_md,
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
