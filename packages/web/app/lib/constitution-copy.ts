// Shared copy for constitution explainer surfaces. Used by:
//   - /new-doco/constitution           (wizard step 2)
//   - /:docoHandle/constitution
//   - /orgs/:orgHandle/constitution
// Keep them DRY so the wording matches the wizard the project owner
// just walked through.

export const GUIDANCE_ARTICLE_EXPLAINER =
  "Short prose AI agents read while working. Not auto-checked — they're a shared agreement.";

export const NODE_AUTHORING_ARTICLE_EXPLAINER =
  'Rules the host evaluates when a node is captured. Either a deterministic predicate (e.g. "every Decision cites at least one Intent") or a probabilistic spec the host runs through an LLM. On violation: block, warn, or log.';

export const AGENT_EXPOSURE_NOTE =
  "AI agents are always exposed to both the org's and the doco's articles at the top of every session.";
