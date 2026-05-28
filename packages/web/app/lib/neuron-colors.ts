/**
 * Color in Doco encodes *lifecycle stage* only — anywhere, in any
 * perspective or view. Neuron type is communicated by shape, icon,
 * and text labels; color is reserved so it always means lifecycle.
 * The previous per-type color palette (NODE_TYPE_COLOR / nodeTypeColor)
 * was removed because it competed with the lifecycle stroke and
 * diluted the meaning of color overall.
 */

// Canonical lifecycle has four stages: drafting, proposed, accepted, retired.
// Per project owner the color mapping is, in that order:
//   drafting  → yellow  (provisional / work in motion)
//   proposed → blue    (under review)
//   accepted → black   (settled, in force)
//   retired  → red     (no longer in use)
export const LIFECYCLE_COLOR: Record<string, string> = {
  drafting: "#ca8a04", // yellow-600 — provisional
  proposed: "#2563eb", // blue-600 — under review
  accepted: "#171717", // gray-900 — settled and in force
  retired: "#dc2626", // red-600 — no longer in use
};

export const LIFECYCLE_FALLBACK_COLOR = "#737373";

export function lifecycleColor(lifecycle: string | null | undefined): string {
  return LIFECYCLE_COLOR[lifecycle ?? "accepted"] ?? LIFECYCLE_FALLBACK_COLOR;
}

/**
 * Picks a readable foreground color (dark or white) for text placed
 * on a lifecycle-colored background. Uses WCAG relative luminance:
 * light backgrounds (e.g. the sky-400 used for `drafting`) get dark
 * text; everything else gets white. Returns hex.
 */
export function textOnLifecycle(lifecycle: string | null | undefined): string {
  const bg = lifecycleColor(lifecycle);
  const hex = bg.startsWith("#") ? bg.slice(1) : bg;
  if (hex.length !== 6) return "#ffffff";
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return "#ffffff";
  // WCAG relative luminance (simplified: skip the gamma correction
  // since we only need a coarse light-vs-dark threshold).
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? "#0f172a" : "#ffffff";
}

/** Human-readable label for a lifecycle stage. */
export function lifecycleLabel(lifecycle: string | null | undefined): string {
  return (lifecycle ?? "accepted").replaceAll("_", " ");
}

const NEURON_TYPE_PLURAL: Record<string, string> = {
  doco: "docos",
  principal: "principals",
  organization: "organizations",
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  guidance_policy: "guidance policies",
  neuron_authoring_policy: "neuron-authoring policies",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "references",
};

export function neuronTypePlural(type: string): string {
  return NEURON_TYPE_PLURAL[type] ?? `${type}s`;
}
