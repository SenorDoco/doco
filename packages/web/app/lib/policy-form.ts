// Parse a policy form submission into a `PolicyDraft`. Shared by the new +
// edit policy routes so the two stay in lock-step. Pure (FormData in, draft
// out); no IO.

import {
  DETERMINISTIC_SUB_KINDS,
  type DeterministicSubKind,
  type FieldSpec,
  checkFields,
} from "@doco/shared";
import type { PolicyDraft } from "~/lib/capture.server";

// The deterministic check menu IS the registry's key list — there is no
// hand-kept copy to drift. Re-exported so the form and its tests keep importing
// it from one place.
export { DETERMINISTIC_SUB_KINDS };

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
  /** requires_edge: floor on matching edges, plus the exemptions that waive it. */
  min_count: string;
  exempt_when_other_node_type: string;
  /** requires_edge / flow-wiring: excused when the node is the target of this incoming edge. */
  exempt_when_incoming_edge_type: string;
  /** requires_edge: excused when the candidate carries a truthy value at this field. */
  exempt_when_field_truthy: string;
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

/**
 * The empty policy form — every input at its default. Shared by the "new policy"
 * route (which renders it as-is) and `policyFormInitialFromData` (which overlays
 * a stored policy onto it), so there is exactly ONE list of form fields, not a
 * separate hand-kept copy in each place to drift apart.
 */
export const EMPTY_POLICY_FORM_INITIAL: PolicyFormInitial = {
  kind: "suggestion",
  agent_instruction: "",
  sub_kind: "requires_field",
  edge_type: "",
  from_node_type: "",
  to_node_type: "",
  target_node_type: "",
  min_count: "",
  exempt_when_other_node_type: "",
  exempt_when_incoming_edge_type: "",
  exempt_when_field_truthy: "",
  max_count: "",
  direction: "",
  fields: "",
  field: "",
  pattern: "",
  flags: "",
  case_fold: false,
  node_types: "",
  edge_types: "",
  entity_types: "",
  list_field: "",
  incoming_node_type: "",
  incoming_field_must_match: "",
  initial_when_field: "",
  initial_when_equals: "",
  terminal_when_field: "",
  terminal_when_equals: "",
  when_node_type: "",
  on_violation: "block",
  fires_when_node_lifecycle: "",
};

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
  const init: PolicyFormInitial = {
    ...EMPTY_POLICY_FORM_INITIAL,
    kind,
    agent_instruction: s(predicate.agent_instruction),
    sub_kind: s(predicate.sub_kind) || "requires_field",
    // Edge scoping carried by an edge-scoped probabilistic policy.
    edge_type: s(predicate.edge_type),
    from_node_type: s(predicate.from_node_type),
    to_node_type: s(predicate.to_node_type),
    when_node_type: joinArr(predicate.when_node_type),
    on_violation: s(data.on_violation) || "block",
    fires_when_node_lifecycle: joinArr(data.fires_when_node_lifecycle),
  };
  // Deterministic check params are flattened straight from the check's registry
  // schema (`checkFields`) — the same schema that renders the form, builds the
  // predicate, and validates it. Deriving the prefill from it too means a field
  // added to a check is editable automatically. The previous hand-kept list
  // silently dropped `exempt_when_incoming_edge_type` / `exempt_when_field_truthy`
  // on every edit, because they were added to the registry but never copied here.
  if (kind === "deterministic") Object.assign(init, flattenDeterministicFields(predicate));
  return init;
}

/**
 * Flatten a stored deterministic predicate into the flat, input-keyed shape the
 * form reads — the inverse of `readFormField`, switching on the same `FieldSpec`
 * controls so the read and write halves can't drift.
 */
function flattenDeterministicFields(
  predicate: Record<string, unknown>,
): Record<string, string | boolean> {
  const sub_kind = typeof predicate.sub_kind === "string" ? predicate.sub_kind : "";
  const out: Record<string, string | boolean> = {};
  for (const field of checkFields(sub_kind as DeterministicSubKind)) {
    const value = predicate[field.name];
    switch (field.control) {
      case "number":
        out[field.name] = typeof value === "number" ? String(value) : "";
        break;
      case "checkbox":
        out[field.name] = value === true;
        break;
      case "node-type-csv":
      case "entity-type-csv":
      case "edge-type-csv":
      case "field-csv":
        out[field.name] = Array.isArray(value)
          ? value.filter((x) => typeof x === "string").join(", ")
          : "";
        break;
      case "condition": {
        // A nested `{ field, equals }` pair, split into `${name}_field` / `_equals`.
        const c = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
        out[`${field.name}_field`] = typeof c.field === "string" ? c.field : "";
        out[`${field.name}_equals`] = typeof c.equals === "string" ? c.equals : "";
        break;
      }
      default:
        // edge-type / node-type / direction / text — a plain string.
        out[field.name] = typeof value === "string" ? value : "";
    }
  }
  return out;
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

// Build the structured predicate generically from the check's field schema —
// the same `FieldSpec[]` that renders the form and validates the result. Adding
// a check needs no edit here; its fields drive the parse.
function buildDeterministicPredicate(
  form: FormData,
  sub_kind: string,
): { predicate: Record<string, unknown> } | { error: string } {
  const predicate: Record<string, unknown> = { sub_kind };
  for (const field of checkFields(sub_kind as DeterministicSubKind)) {
    const value = readFormField(form, field);
    if (value === undefined) {
      if (field.required) return { error: requiredError(field) };
      continue;
    }
    predicate[field.name] = value;
  }
  return { predicate };
}

/** Read one schema field from the form, or undefined when it is blank/omitted. */
function readFormField(form: FormData, field: FieldSpec): unknown {
  switch (field.control) {
    case "number":
      return intField(form, field.name);
    case "checkbox":
      return form.get(field.name) != null ? true : undefined;
    case "node-type-csv":
    case "entity-type-csv":
    case "edge-type-csv":
    case "field-csv": {
      const arr = csv(form, field.name);
      return arr.length > 0 ? arr : undefined;
    }
    case "condition": {
      const cField = str(form, `${field.name}_field`);
      const cEquals = str(form, `${field.name}_equals`);
      return cField && cEquals ? { field: cField, equals: cEquals } : undefined;
    }
    case "direction": {
      const v = str(form, field.name);
      return v === "incoming" || v === "outgoing" ? v : undefined;
    }
    default: {
      // edge-type / node-type / text — a trimmed non-empty string.
      const v = str(form, field.name);
      return v ? v : undefined;
    }
  }
}

function requiredError(field: FieldSpec): string {
  switch (field.control) {
    case "edge-type":
      return "edge_type is required.";
    case "field-csv":
      return "At least one field is required.";
    case "node-type-csv":
      return "At least one node type is required.";
    case "entity-type-csv":
      return "At least one entity type is required.";
    case "edge-type-csv":
      return "At least one edge type is required.";
    default:
      return `${field.name} is required.`;
  }
}
