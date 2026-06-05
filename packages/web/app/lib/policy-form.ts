// Parse a policy form submission into a `PolicyDraft`. Shared by the new +
// edit policy routes so the two stay in lock-step. Pure (FormData in, draft
// out); no IO.

import type { PolicyDraft } from "~/lib/capture.server";

// Every deterministic check the engine understands must appear here, or the
// edit form's check-type menu can't display it — and saving such a policy
// would silently rewrite it to a different predicate. Keep this in lock-step
// with `DeterministicPredicate` in @doco/shared.
export const DETERMINISTIC_SUB_KINDS = [
  "requires_edge",
  "limits_edge",
  "forbids_edge",
  "requires_edge_type",
  "requires_field",
  "forbids_field",
  "forbids_field_pattern",
  "flow-wiring",
  "unique_field",
  "requires_node_type",
  "requires_entity_type",
  "graph-completeness",
  "requires_field_resolves_to_principal",
] as const;

/** Flattened form field values used to prefill the policy form on edit. */
export interface PolicyFormInitial {
  kind: "suggestion" | "deterministic" | "probabilistic";
  agent_instruction: string;
  sub_kind: string;
  edge_type: string;
  /** Edge-scoped probabilistic policy: endpoint node types for the edge it fires on. */
  from_node_type: string;
  to_node_type: string;
  target_node_type: string;
  /** requires_edge: floor on matching edges; the node type that waives it. */
  min_count: string;
  exempt_when_other_node_type: string;
  /** limits_edge: ceiling on matching edges. */
  max_count: string;
  /** requires_edge / limits_edge: which way the edge must point. */
  direction: string;
  fields: string;
  field: string;
  /** forbids_field_pattern: the regex and its flags. */
  pattern: string;
  flags: string;
  case_fold: boolean;
  node_types: string;
  /** requires_edge_type: the edge-type allowlist (CSV). */
  edge_types: string;
  entity_types: string;
  list_field: string;
  incoming_node_type: string;
  incoming_field_must_match: string;
  /** flow-wiring: the field/value pairs that mark initial and terminal nodes. */
  initial_when_field: string;
  initial_when_equals: string;
  terminal_when_field: string;
  terminal_when_equals: string;
  when_node_type: string;
  on_violation: string;
  fires_when_node_lifecycle: string;
}

/** Derive prefilled form values from a stored policy `data` jsonb. */
export function policyFormInitialFromData(data: Record<string, unknown>): PolicyFormInitial {
  const kind =
    data.kind === "deterministic" || data.kind === "probabilistic" ? data.kind : "suggestion";
  const predicate = (
    data.predicate && typeof data.predicate === "object" ? data.predicate : {}
  ) as Record<string, unknown>;
  const joinArr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "";
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" ? String(v) : "");
  // initial_when / terminal_when are nested `{ field, equals }` objects.
  const condField = (v: unknown, key: "field" | "equals") =>
    s((v && typeof v === "object" ? (v as Record<string, unknown>) : {})[key]);
  return {
    kind,
    agent_instruction: s(predicate.agent_instruction),
    sub_kind: s(predicate.sub_kind) || "requires_field",
    edge_type: s(predicate.edge_type),
    from_node_type: s(predicate.from_node_type),
    to_node_type: s(predicate.to_node_type),
    target_node_type: s(predicate.target_node_type),
    min_count: num(predicate.min_count),
    exempt_when_other_node_type: s(predicate.exempt_when_other_node_type),
    max_count: num(predicate.max_count),
    direction: s(predicate.direction),
    fields: joinArr(predicate.fields),
    field: s(predicate.field),
    pattern: s(predicate.pattern),
    flags: s(predicate.flags),
    case_fold: predicate.case_fold === true,
    node_types: joinArr(predicate.node_types),
    edge_types: joinArr(predicate.edge_types),
    entity_types: joinArr(predicate.entity_types),
    list_field: s(predicate.list_field),
    incoming_node_type: s(predicate.incoming_node_type),
    incoming_field_must_match: s(predicate.incoming_field_must_match),
    initial_when_field: condField(predicate.initial_when, "field"),
    initial_when_equals: condField(predicate.initial_when, "equals"),
    terminal_when_field: condField(predicate.terminal_when, "field"),
    terminal_when_equals: condField(predicate.terminal_when, "equals"),
    when_node_type: joinArr(predicate.when_node_type),
    on_violation: s(data.on_violation) || "block",
    fires_when_node_lifecycle: joinArr(data.fires_when_node_lifecycle),
  };
}

function csv(form: FormData, key: string): string[] {
  return String(form.get(key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function str(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

/** A non-negative integer field, or undefined when blank/invalid (so it is omitted). */
function intField(form: FormData, key: string): number | undefined {
  const raw = str(form, key);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Edge direction, constrained to the two the engine accepts. */
function directionField(form: FormData): "incoming" | "outgoing" | undefined {
  const v = str(form, "direction");
  return v === "incoming" || v === "outgoing" ? v : undefined;
}

/** A flow-wiring `{ field, equals }` condition — included only when both halves are present. */
function conditionField(
  form: FormData,
  prefix: "initial_when" | "terminal_when",
): { field: string; equals: string } | undefined {
  const field = str(form, `${prefix}_field`);
  const equals = str(form, `${prefix}_equals`);
  return field && equals ? { field, equals } : undefined;
}

export function policyDraftFromForm(form: FormData): PolicyDraft | { error: string } {
  const kind = str(form, "kind");
  if (kind !== "suggestion" && kind !== "deterministic" && kind !== "probabilistic") {
    return { error: "kind must be suggestion, deterministic, or probabilistic." };
  }
  const firesWhen = csv(form, "fires_when_node_lifecycle");
  const onViolationRaw = str(form, "on_violation");
  const on_violation =
    onViolationRaw === "warn" || onViolationRaw === "log" ? onViolationRaw : "block";

  if (kind === "suggestion" || kind === "probabilistic") {
    const agent_instruction = str(form, "agent_instruction");
    if (!agent_instruction) return { error: "Agent instruction is required." };
    const when = csv(form, "when_node_type");
    // Edge-scoped probabilistic: an `edge_type` makes the policy fire on edge
    // creation (judge sees both endpoints) instead of on a node. `when_node_type`
    // does not apply to an edge-scoped policy, so it is dropped when edge_type is set.
    const edge_type = kind === "probabilistic" ? str(form, "edge_type") : "";
    const from_node_type = str(form, "from_node_type");
    const to_node_type = str(form, "to_node_type");
    return {
      kind: kind as "suggestion" | "probabilistic",
      agent_instruction,
      ...(kind === "probabilistic" && edge_type
        ? {
            edge_type,
            ...(from_node_type ? { from_node_type } : {}),
            ...(to_node_type ? { to_node_type } : {}),
          }
        : kind === "probabilistic" && when.length > 0
          ? { when_node_type: when }
          : {}),
      ...(kind === "probabilistic" ? { on_violation } : {}),
      ...(firesWhen.length > 0 ? { fires_when_node_lifecycle: firesWhen } : {}),
    };
  }

  // deterministic
  const sub_kind = str(form, "sub_kind");
  if (!(DETERMINISTIC_SUB_KINDS as readonly string[]).includes(sub_kind)) {
    return { error: "Choose a deterministic check type." };
  }
  const built = buildDeterministicPredicate(form, sub_kind);
  if ("error" in built) return built;
  return {
    kind: "deterministic",
    // capturePolicy re-validates the parsed object.
    predicate: JSON.stringify(built.predicate),
    on_violation,
    ...(firesWhen.length > 0 ? { fires_when_node_lifecycle: firesWhen } : {}),
  };
}

function buildDeterministicPredicate(
  form: FormData,
  sub_kind: string,
): { predicate: Record<string, unknown> } | { error: string } {
  const when = csv(form, "when_node_type");
  const withWhen = (p: Record<string, unknown>) => ({
    predicate: when.length > 0 ? { ...p, when_node_type: when } : p,
  });
  switch (sub_kind) {
    case "requires_edge": {
      const edge_type = str(form, "edge_type");
      if (!edge_type) return { error: "edge_type is required." };
      const target = str(form, "target_node_type");
      const min_count = intField(form, "min_count");
      const direction = directionField(form);
      const exempt = str(form, "exempt_when_other_node_type");
      return withWhen({
        sub_kind,
        edge_type,
        ...(target ? { target_node_type: target } : {}),
        ...(min_count !== undefined ? { min_count } : {}),
        ...(direction ? { direction } : {}),
        ...(exempt ? { exempt_when_other_node_type: exempt } : {}),
      });
    }
    case "limits_edge": {
      const edge_type = str(form, "edge_type");
      if (!edge_type) return { error: "edge_type is required." };
      const target = str(form, "target_node_type");
      const direction = directionField(form);
      const max_count = intField(form, "max_count");
      return withWhen({
        sub_kind,
        edge_type,
        ...(target ? { target_node_type: target } : {}),
        ...(direction ? { direction } : {}),
        ...(max_count !== undefined ? { max_count } : {}),
      });
    }
    case "forbids_edge": {
      const edge_type = str(form, "edge_type");
      if (!edge_type) return { error: "edge_type is required." };
      const target = str(form, "target_node_type");
      return withWhen({ sub_kind, edge_type, ...(target ? { target_node_type: target } : {}) });
    }
    case "requires_edge_type": {
      const edge_types = csv(form, "edge_types");
      if (edge_types.length === 0) return { error: "At least one edge type is required." };
      return { predicate: { sub_kind, edge_types } };
    }
    case "requires_field":
    case "forbids_field": {
      const fields = csv(form, "fields");
      if (fields.length === 0) return { error: "At least one field is required." };
      return withWhen({ sub_kind, fields });
    }
    case "forbids_field_pattern": {
      const fields = csv(form, "fields");
      if (fields.length === 0) return { error: "At least one field is required." };
      const pattern = str(form, "pattern");
      if (!pattern) return { error: "pattern is required." };
      const flags = str(form, "flags");
      return withWhen({ sub_kind, fields, pattern, ...(flags ? { flags } : {}) });
    }
    case "flow-wiring": {
      const edge_type = str(form, "edge_type");
      if (!edge_type) return { error: "edge_type is required." };
      const initial_when = conditionField(form, "initial_when");
      const terminal_when = conditionField(form, "terminal_when");
      return withWhen({
        sub_kind,
        edge_type,
        ...(initial_when ? { initial_when } : {}),
        ...(terminal_when ? { terminal_when } : {}),
      });
    }
    case "unique_field": {
      const field = str(form, "field");
      if (!field) return { error: "field is required." };
      const case_fold = form.get("case_fold") != null;
      return withWhen({ sub_kind, field, ...(case_fold ? { case_fold: true } : {}) });
    }
    case "requires_node_type": {
      const node_types = csv(form, "node_types");
      if (node_types.length === 0) return { error: "At least one node type is required." };
      return { predicate: { sub_kind, node_types } };
    }
    case "requires_entity_type": {
      const entity_types = csv(form, "entity_types");
      if (entity_types.length === 0) return { error: "At least one entity type is required." };
      return { predicate: { sub_kind, entity_types } };
    }
    case "requires_field_resolves_to_principal": {
      const field = str(form, "field");
      if (!field) return { error: "field is required." };
      return withWhen({ sub_kind, field });
    }
    case "graph-completeness": {
      const list_field = str(form, "list_field");
      const edge_type = str(form, "edge_type");
      const incoming_node_type = str(form, "incoming_node_type");
      const incoming_field_must_match = str(form, "incoming_field_must_match");
      if (!list_field || !edge_type || !incoming_node_type || !incoming_field_must_match) {
        return {
          error:
            "graph-completeness needs list_field, edge_type, incoming_node_type, and incoming_field_must_match.",
        };
      }
      return withWhen({
        sub_kind,
        list_field,
        edge_type,
        incoming_node_type,
        incoming_field_must_match,
      });
    }
    default:
      return { error: "Unknown deterministic check type." };
  }
}
