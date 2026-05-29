// Mutability gate per the "frozen claims, mutable records" Decision
// (decision_01KRKEPRAMM9QSSEJ2X5FHPESJ).
//
// Two classes of node:
//   - Claim: Decision, Intent, Rule, Action, Eval, Reference.
//     Mutable while in a draft lifecycle; frozen on activation. On a frozen
//     claim, only lifecycle metadata, `superseded_by`, and additive edge fields
//     (`*_add`) can be patched. Body, summary, alternatives, and core fields
//     are locked — editorial fixes happen via supersession.
//   - Record: Principal, Organization, Doco metadata, Tag, Idea.
//     Always mutable via PATCH. They are state, not claims.
//
// Frozen lifecycles use the canonical Lifecycle vocabulary
// (drafting, proposed, accepted, retired) — see shared/entities.ts.
// `drafting` and `proposed` are mutable; `accepted` and `retired` freeze
// the claim except for lifecycle metadata and the supersession path.

export type NodeClass = "claim" | "record";

export type ClaimNodeType =
  | "decision"
  | "intent"
  | "rule"
  | "guidance_policy"
  | "neuron_authoring_policy"
  | "action"
  | "log"
  | "eval"
  | "reference";

export type RecordNodeType = "principal" | "organization" | "doco" | "tag" | "idea";

const CLAIM_TYPES: ReadonlySet<string> = new Set<ClaimNodeType>([
  "decision",
  "intent",
  "rule",
  "guidance_policy",
  "neuron_authoring_policy",
  "action",
  "log",
  "eval",
  "reference",
]);

export function nodeClassOf(entityType: string): NodeClass {
  return CLAIM_TYPES.has(entityType) ? "claim" : "record";
}

// Per-type lifecycle states that put a claim into the frozen state.
// `proposed` (and unset) leaves the claim mutable for drafting.
const FROZEN_LIFECYCLES: Record<ClaimNodeType, ReadonlySet<string>> = {
  decision: new Set(["accepted", "retired"]),
  intent: new Set(["accepted", "retired"]),
  rule: new Set(["accepted", "retired"]),
  guidance_policy: new Set(["accepted", "retired"]),
  neuron_authoring_policy: new Set(["accepted", "retired"]),
  action: new Set(["accepted", "retired"]),
  eval: new Set(["accepted", "retired"]),
  // Log records a thing that happened — frozen from creation so the audit
  // trail stays trustworthy. Editorial fixes go through supersession.
  // Sentinel "*" is matched specially below to mean "any lifecycle, including unset".
  log: new Set(["*"]),
  // Reference has no proposed phase — it is frozen from creation.
  reference: new Set(["*"]),
};

/**
 * Is the given claim frozen at the given lifecycle? Records are never
 * frozen — they always return false here.
 */
export function isFrozen(entityType: string, lifecycle: string | undefined | null): boolean {
  if (nodeClassOf(entityType) !== "claim") return false;
  const frozenStates = FROZEN_LIFECYCLES[entityType as ClaimNodeType];
  if (!frozenStates) return false;
  if (frozenStates.has("*")) return true;
  return typeof lifecycle === "string" && frozenStates.has(lifecycle);
}

// Patch keys that are still allowed when a claim is frozen.
// Everything else is rejected.
const ALLOWED_ON_FROZEN: ReadonlySet<string> = new Set([
  "lifecycle",
  "deprecated",
  "outcome",
  "superseded_by",
  "intent_ids_add",
  // Code-artifact Reference links (PRs/commits/files) accrue and *move*
  // throughout a claim's lifetime: PRs land after an ADR is accepted, and
  // the code under a BPMN step gets refactored — while the step's own id
  // is cited in code-comment URLs, so supersession isn't viable. Editable
  // on a frozen claim like `sequence_to` / `target_ref`; replace-only like
  // every relationship list (audit_events records each change regardless).
  "implemented_by",
  // Graph/perspective relations may be attached after a claim is activated.
  // The claim text stays frozen; the flow edge is authored separately.
  "sequence_to",
  // The `tests` relation (Eval/Reference → target neuron). Re-pointing the
  // edge is authoring metadata, not a change to the frozen claim text.
  "target_ref",
]);

export interface PatchValidation {
  allowed: boolean;
  rejected: string[];
  hint?: string;
}

/**
 * Inspect a PATCH body against the mutability gate. For frozen claims,
 * any key not in `ALLOWED_ON_FROZEN` is rejected and a supersede hint is
 * included.
 */
export function validatePatch(
  entityType: string,
  currentLifecycle: string | undefined | null,
  patch: Record<string, unknown>,
): PatchValidation {
  if (!isFrozen(entityType, currentLifecycle)) {
    return { allowed: true, rejected: [] };
  }
  const rejected: string[] = [];
  for (const key of Object.keys(patch)) {
    // Ignore undefined values — they are no-ops on a merge.
    if (patch[key] === undefined) continue;
    if (!ALLOWED_ON_FROZEN.has(key)) rejected.push(key);
  }
  if (rejected.length === 0) return { allowed: true, rejected: [] };
  const noun = entityType.charAt(0).toUpperCase() + entityType.slice(1);
  const hint =
    entityType === "decision"
      ? `This ${noun} is frozen (lifecycle=${currentLifecycle}). Use POST /api/decisions.json to capture a superseding ${noun}, then PATCH the prior with {lifecycle: "retired", superseded_by: <new id>}.`
      : `This ${noun} is frozen (lifecycle=${currentLifecycle}). Capture a new ${noun} that supersedes it, then transition this one's lifecycle.`;
  return { allowed: false, rejected, hint };
}
