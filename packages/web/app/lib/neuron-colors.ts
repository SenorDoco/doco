/**
 * Color in Doco encodes *lifecycle stage* only — anywhere, in any
 * perspective or view. Neuron type is communicated by shape, icon,
 * and text labels; color is reserved so it always means lifecycle.
 * The previous per-type color palette (NODE_TYPE_COLOR / nodeTypeColor)
 * was removed because it competed with the lifecycle stroke and
 * diluted the meaning of color overall.
 */

// Lifecycle is being simplified in @doco/shared to four stages:
// drafted, proposed, active, retired. Per project owner the color
// mapping is, in that order:
//   drafted  → yellow  (provisional / work in motion)
//   proposed → blue    (under review)
//   active   → black   (settled, in force)
//   retired  → red     (no longer in use)
// `draft` is kept as an alias for legacy data drift. Pre-simplified
// stages (succeeded / superseded / abandoned / failed) intentionally
// fall through to LIFECYCLE_FALLBACK_COLOR so they read as "unknown
// — not migrated yet" until the data migration runs.
export const LIFECYCLE_COLOR: Record<string, string> = {
  drafted: "#eab308", // yellow-500 — provisional
  draft: "#eab308", // alias
  proposed: "#2563eb", // blue-600 — under review
  active: "#171717", // gray-900 — settled and in force
  retired: "#dc2626", // red-600 — no longer in use
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
