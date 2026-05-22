/**
 * Color in Doco encodes *lifecycle stage* only — anywhere, in any
 * perspective or view. Neuron type is communicated by shape, icon,
 * and text labels; color is reserved so it always means lifecycle.
 * The previous per-type color palette (NODE_TYPE_COLOR / nodeTypeColor)
 * was removed because it competed with the lifecycle stroke and
 * diluted the meaning of color overall.
 */

export const LIFECYCLE_COLOR: Record<string, string> = {
  active: "#16a34a",
  in_progress: "#ca8a04",
  in_progess: "#ca8a04",
  planned: "#171717",
  proposed: "#2563eb",
  abandoned: "#737373",
  retired: "#737373",
  succeeded: "#737373",
  successed: "#737373",
  superseded: "#737373",
  superseeded: "#737373",
  draft: "#dc2626",
  drafted: "#dc2626",
  failed: "#dc2626",
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
  guidance_primitive: "guidance primitives",
  neuron_authoring_primitive: "neuron-authoring primitives",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "references",
};

export function nodeTypePlural(type: string): string {
  return NODE_TYPE_PLURAL[type] ?? `${type}s`;
}
