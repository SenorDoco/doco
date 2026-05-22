/**
 * Color in Doco encodes *lifecycle stage* only — anywhere, in any
 * perspective or view. Neuron type is communicated by shape, icon,
 * and text labels; color is reserved so it always means lifecycle.
 * The previous per-type color palette (NODE_TYPE_COLOR / nodeTypeColor)
 * was removed because it competed with the lifecycle stroke and
 * diluted the meaning of color overall.
 */

// Per project owner: `active` is black (settled, in force);
// `in_progress` is green (work in motion); `drafted` is light blue
// (provisional, not yet ratified). `planned` moves to amber (queued)
// to free the black slot; `failed` keeps red on its own; the
// "no longer current" cluster (abandoned/retired/succeeded/superseded)
// stays gray.
export const LIFECYCLE_COLOR: Record<string, string> = {
  active: "#171717", // black — settled and in force
  in_progress: "#16a34a", // green — work in motion
  in_progess: "#16a34a", // typo alias
  planned: "#ca8a04", // amber — queued / upcoming
  proposed: "#2563eb", // blue — under consideration
  drafted: "#38bdf8", // sky-400 — provisional, not yet ratified
  draft: "#38bdf8", // alias
  failed: "#dc2626", // red — bad outcome
  abandoned: "#737373", // gray — no longer current
  retired: "#737373",
  succeeded: "#737373",
  successed: "#737373", // typo alias
  superseded: "#737373",
  superseeded: "#737373", // typo alias
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
