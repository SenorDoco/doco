/**
 * Twelve distinct hues, no two visually adjacent. The four most-visible
 * types in the entity-detail graph (decision, scope, intent, principal)
 * occupy widely-separated parts of the wheel so they never read as
 * "all sort of green-ish."
 *   decision  -> orange     (warm, action-shaped)
 *   scope     -> lime green (categorical neighborhood)
 *   intent    -> magenta    (was emerald, collided with scope/lime)
 *   principal -> cyan       (was blue, collided with organization/indigo)
 */
export const NODE_TYPE_COLOR: Record<string, string> = {
  doco: "#525252", // gray
  principal: "#06b6d4", // cyan
  organization: "#6366f1", // indigo
  intent: "#d946ef", // magenta
  idea: "#f43f5e", // rose
  rule: "#dc2626", // red
  decision: "#f97316", // orange
  action: "#7c3aed", // purple
  log: "#14b8a6", // teal — instance-of-Action, distinct from purple
  eval: "#0ea5e9", // sky
  reference: "#a16207", // amber/brown
  scope: "#84cc16", // lime
};

export const NODE_FALLBACK_COLOR = "#525252";

export function nodeTypeColor(type: string): string {
  return NODE_TYPE_COLOR[type] ?? NODE_FALLBACK_COLOR;
}

export const LIFECYCLE_COLOR: Record<string, string> = {
  abandoned: "#dc2626",
  failed: "#dc2626",
  superseded: "#9333ea",
  retired: "#9333ea",
  proposed: "#2563eb",
  planned: "#2563eb",
  in_progress: "#2563eb",
  active: "#16a34a",
  succeeded: "#16a34a",
  drafted: "#ca8a04",
};

export const LIFECYCLE_FALLBACK_COLOR = "#737373";

export function lifecycleColor(lifecycle: string | null | undefined): string {
  return LIFECYCLE_COLOR[lifecycle ?? "active"] ?? LIFECYCLE_FALLBACK_COLOR;
}

const NODE_TYPE_PLURAL: Record<string, string> = {
  doco: "docos",
  principal: "principals",
  organization: "organizations",
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "references",
  scope: "scopes",
};

export function nodeTypePlural(type: string): string {
  return NODE_TYPE_PLURAL[type] ?? `${type}s`;
}
