/**
 * Color in Doco encodes *lifecycle stage* only — anywhere, in any
 * perspective or view. Neuron type is communicated by shape, icon,
 * and text labels; color is reserved so it always means lifecycle.
 * The previous per-type color palette (NODE_TYPE_COLOR / nodeTypeColor)
 * was removed because it competed with the lifecycle stroke and
 * diluted the meaning of color overall.
 */

// Canonical Lifecycle (packages/shared/src/entities.ts) has exactly
// seven stages: drafted, proposed, active, succeeded, failed,
// superseded, abandoned. Per project owner:
//   active   → black   (settled, in force)
//   drafted  → sky-400 (provisional, not yet ratified)
//   proposed → blue    (under consideration)
//   failed   → red     (bad outcome — alone on red)
//   the "no longer current" cluster (abandoned / succeeded /
//   superseded) stays gray.
// `draft` / `successed` / `superseeded` are kept as aliases for
// legacy data drift; their canonical spellings drive the color.
export const LIFECYCLE_COLOR: Record<string, string> = {
  active: "#171717", // black — settled and in force
  drafted: "#38bdf8", // sky-400 — provisional, not yet ratified
  draft: "#38bdf8", // alias
  proposed: "#2563eb", // blue — under consideration
  failed: "#dc2626", // red — bad outcome
  succeeded: "#737373", // gray — no longer current
  successed: "#737373", // typo alias
  superseded: "#737373",
  superseeded: "#737373", // typo alias
  abandoned: "#737373",
};

export const LIFECYCLE_FALLBACK_COLOR = "#737373";

export function lifecycleColor(lifecycle: string | null | undefined): string {
  return LIFECYCLE_COLOR[lifecycle ?? "active"] ?? LIFECYCLE_FALLBACK_COLOR;
}

/**
 * Picks a readable foreground color (dark or white) for text placed
 * on a lifecycle-colored background. Uses WCAG relative luminance:
 * light backgrounds (e.g. the sky-400 used for `drafted`) get dark
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
  return (lifecycle ?? "active").replaceAll("_", " ");
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
