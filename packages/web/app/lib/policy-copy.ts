// Shared copy for policy surfaces. Used by:
//   - /:docoHandle/policies
//   - the Doco new/edit policy forms
// Keep them DRY so the wording matches across the wizard surfaces.

export const POLICIES_EXPLAINER =
  "Every policy is an authoring policy. Suggestions are advisory; deterministic and probabilistic policies are evaluated when something is added to this Doco.";

export const AGENT_EXPOSURE_NOTE =
  "AI agents are always exposed to this Doco's policies on every session.";

export const POLICY_KIND_HELP: Record<"suggestion" | "deterministic" | "probabilistic", string> = {
  suggestion: "Advisory only — surfaced to agents, never enforced. Carries one agent instruction.",
  deterministic: "A strict structural check the engine evaluates at write time.",
  probabilistic: "An LLM judge evaluates one natural-language instruction at write time.",
};
