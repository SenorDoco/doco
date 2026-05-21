// Mutability gate per the "frozen claims, mutable records" Decision
// (decision_01KRKEPRAMM9QSSEJ2X5FHPESJ).
//
// Two classes of node:
//   - Claim: Decision, Intent, Rule, Action, Eval, Reference.
//     Mutable while in a draft lifecycle; frozen on activation. On a frozen
//     claim, only `lifecycle`, `superseded_by`, and additive edge fields
//     (`*_add`) can be patched. Body, summary, alternatives, and core fields
//     are locked — editorial fixes happen via supersession.
//   - Record: Principal, Organization, Scope, Doco metadata, Tag, Idea.
//     Always mutable via PATCH. They are state, not claims.
//
// Frozen lifecycles use the canonical six-value Lifecycle vocabulary
// (proposed, active, succeeded, failed, superseded, abandoned) — see
// shared/entities.ts. `proposed` is always mutable (drafting); the rest
// freeze the claim except for the supersession path.

export type NodeClass = "claim" | "record";

export type ClaimNodeType =
  | "decision"
  | "intent"
  | "rule"
  | "guidance_article"
  | "node_authoring_article"
  | "action"
  | "log"
  | "eval"
  | "reference";

export type RecordNodeType = "principal" | "organization" | "doco" | "tag" | "idea";

const CLAIM_TYPES: ReadonlySet<string> = new Set<ClaimNodeType>([
  "decision",
  "intent",
  "rule",
  "guidance_article",
  "node_authoring_article",
  "action",
  "log",
  "eval",
  "reference",
]);

export function nodeClassOf(nodeType: string): NodeClass {
  return CLAIM_TYPES.has(nodeType) ? "claim" : "record";
}

// Per-type lifecycle states that put a claim into the frozen state.
// `proposed` (and unset) leaves the claim mutable for drafting.
const FROZEN_LIFECYCLES: Record<ClaimNodeType, ReadonlySet<string>> = {
  decision: new Set(["active", "succeeded", "failed", "superseded", "abandoned"]),
  intent: new Set(["active", "succeeded", "failed", "superseded", "abandoned"]),
  rule: new Set(["active", "succeeded", "failed", "superseded", "abandoned"]),
  guidance_article: new Set(["active", "succeeded", "failed", "superseded", "abandoned"]),
  node_authoring_article: new Set(["active", "succeeded", "failed", "superseded", "abandoned"]),
  action: new Set(["active", "succeeded", "failed", "superseded", "abandoned"]),
  eval: new Set(["active", "succeeded", "failed", "superseded", "abandoned"]),
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
export function isFrozen(nodeType: string, lifecycle: string | undefined | null): boolean {
  if (nodeClassOf(nodeType) !== "claim") return false;
  const frozenStates = FROZEN_LIFECYCLES[nodeType as ClaimNodeType];
  if (!frozenStates) return false;
  if (frozenStates.has("*")) return true;
  return typeof lifecycle === "string" && frozenStates.has(lifecycle);
}

// Patch keys that are still allowed when a claim is frozen.
// Everything else is rejected.
const ALLOWED_ON_FROZEN: ReadonlySet<string> = new Set([
  "lifecycle",
  "superseded_by",
  "scope_names_add",
  "intent_ids_add",
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
  nodeType: string,
  currentLifecycle: string | undefined | null,
  patch: Record<string, unknown>,
): PatchValidation {
  if (!isFrozen(nodeType, currentLifecycle)) {
    return { allowed: true, rejected: [] };
  }
  const rejected: string[] = [];
  for (const key of Object.keys(patch)) {
    // Ignore undefined values — they are no-ops on a merge.
    if (patch[key] === undefined) continue;
    if (!ALLOWED_ON_FROZEN.has(key)) rejected.push(key);
  }
  if (rejected.length === 0) return { allowed: true, rejected: [] };
  const noun = nodeType.charAt(0).toUpperCase() + nodeType.slice(1);
  const hint =
    nodeType === "decision"
      ? `This ${noun} is frozen (lifecycle=${currentLifecycle}). Use POST /api/decisions.json to capture a superseding ${noun}, then PATCH the prior with {lifecycle: "superseded"}.`
      : `This ${noun} is frozen (lifecycle=${currentLifecycle}). Capture a new ${noun} that supersedes it, then transition this one's lifecycle.`;
  return { allowed: false, rejected, hint };
}
