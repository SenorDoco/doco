// Parse a policy form submission into a `PolicyDraft`. Shared by the new +
// edit policy routes so the two stay in lock-step. Pure (FormData in, draft
// out); no IO.

import type { PolicyDraft } from "~/lib/capture.server";

export const DETERMINISTIC_SUB_KINDS = [
  "requires_edge",
  "forbids_edge",
  "requires_field",
  "forbids_field",
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
  fields: string;
  field: string;
  case_fold: boolean;
  node_types: string;
  entity_types: string;
  list_field: string;
  incoming_node_type: string;
  incoming_field_must_match: string;
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
  return {
    kind,
    agent_instruction: s(predicate.agent_instruction),
    sub_kind: s(predicate.sub_kind) || "requires_field",
    edge_type: s(predicate.edge_type),
    from_node_type: s(predicate.from_node_type),
    to_node_type: s(predicate.to_node_type),
    target_node_type: s(predicate.target_node_type),
    fields: joinArr(predicate.fields),
    field: s(predicate.field),
    case_fold: predicate.case_fold === true,
    node_types: joinArr(predicate.node_types),
    entity_types: joinArr(predicate.entity_types),
    list_field: s(predicate.list_field),
    incoming_node_type: s(predicate.incoming_node_type),
    incoming_field_must_match: s(predicate.incoming_field_must_match),
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
    case "requires_edge":
    case "forbids_edge": {
      const edge_type = str(form, "edge_type");
      if (!edge_type) return { error: "edge_type is required." };
      const target = str(form, "target_node_type");
      return withWhen({ sub_kind, edge_type, ...(target ? { target_node_type: target } : {}) });
    }
    case "requires_field":
    case "forbids_field": {
      const fields = csv(form, "fields");
      if (fields.length === 0) return { error: "At least one field is required." };
      return withWhen({ sub_kind, fields });
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
