// Mutability gate.
//
// The original model ("frozen claims, mutable records",
// decision_01KRKEPRAMM9QSSEJ2X5FHPESJ) froze a claim's body once it
// reached an `accepted`/`retired` lifecycle, forcing editorial fixes
// through supersession. That built-in freeze has been removed: any
// principal with write access may add, edit, retire, or transition the
// lifecycle of any neuron or synapse. Nothing is ever hard-deleted —
// removal is a lifecycle transition to `retired`, and every change is
// recorded in `audit_events` — so history stays intact even though the
// current row is mutable.
//
// What a writer may or may not do is now governed exclusively by the
// Doco's own policies (guidance + neuron-authoring policies evaluated
// in the authoring runner), not by a hard-coded role/lifecycle freeze.
// This module keeps its shape so existing call sites compile, but the
// gate is permissive: it never blocks a patch.

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

/**
 * Whether the given claim is frozen. There is no built-in freeze any
 * more — writers may edit neurons at every lifecycle — so this always
 * returns false. Retained for callers that still ask.
 */
export function isFrozen(_entityType: string, _lifecycle: string | undefined | null): boolean {
  return false;
}

export interface PatchValidation {
  allowed: boolean;
  rejected: string[];
  hint?: string;
}

/**
 * Inspect a PATCH body against the mutability gate. With the built-in
 * freeze removed, every patch is allowed; field-level restrictions, if
 * any, are enforced by the Doco's policies in the authoring runner.
 */
export function validatePatch(
  _entityType: string,
  _currentLifecycle: string | undefined | null,
  _patch: Record<string, unknown>,
): PatchValidation {
  return { allowed: true, rejected: [] };
}
