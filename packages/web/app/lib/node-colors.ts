/**
 * Color in Doco encodes *lifecycle stage* only — anywhere, in any
 * perspective or view. Node type is communicated by shape, icon,
 * and text labels; color is reserved so it always means lifecycle.
 * The previous per-type color palette (NODE_TYPE_COLOR / nodeTypeColor)
 * was removed because it competed with the lifecycle stroke and
 * diluted the meaning of color overall.
 */

// Canonical lifecycle has three stages: drafting, asserted, retired.
// Per project owner the color mapping is, in that order:
//   drafting → blue   (provisional / work in motion)
//   asserted → black  (settled, in force)
//   retired  → red    (no longer in use)
export const LIFECYCLE_COLOR: Record<string, string> = {
  // Same blue the now-removed `proposed` stage used, re-used for drafting.
  drafting: "#2563eb", // blue-600 — provisional
  asserted: "#171717", // gray-900 — settled and in force
  retired: "#dc2626", // red-600 — no longer in use
};

export const LIFECYCLE_FALLBACK_COLOR = "#737373";

export function lifecycleColor(lifecycle: string | null | undefined): string {
  return LIFECYCLE_COLOR[lifecycle ?? "asserted"] ?? LIFECYCLE_FALLBACK_COLOR;
}

/**
 * One-line explanation of each lifecycle stage, surfaced as the hover
 * title on a colored count so the meaning of each color is discoverable
 * without a separate legend. Wording mirrors the LIFECYCLE_COLOR notes.
 */
export const LIFECYCLE_DESCRIPTION: Record<string, string> = {
  drafting: "Drafting — provisional, work in motion",
  asserted: "Asserted — settled, in force",
  retired: "Retired — no longer in use",
};

export function lifecycleDescription(lifecycle: string | null | undefined): string {
  return LIFECYCLE_DESCRIPTION[lifecycle ?? "asserted"] ?? lifecycleLabel(lifecycle);
}

/**
 * Canonical lifecycle progression. Counts, filter rows, and the stats
 * cards all render the stages in this order so a given color always
 * lands in the same position.
 */
export const LIFECYCLE_ORDER = ["drafting", "asserted", "retired"] as const;

/** A node count broken out by lifecycle stage. */
export interface LifecycleCounts {
  drafting: number;
  asserted: number;
  retired: number;
}

export const EMPTY_LIFECYCLE_COUNTS: LifecycleCounts = {
  drafting: 0,
  asserted: 0,
  retired: 0,
};

/**
 * Expand a {@link LifecycleCounts} into canonical-order parts, each
 * tagged with its lifecycle color, ready to render as
 * `drafting / asserted / retired`. All three stages are always present
 * (zeros included) so a color's position stays stable.
 */
export function lifecycleCountParts(
  counts: LifecycleCounts,
): { lifecycle: string; count: number; color: string; title: string }[] {
  return LIFECYCLE_ORDER.map((lifecycle) => ({
    lifecycle,
    count: counts[lifecycle],
    color: lifecycleColor(lifecycle),
    title: lifecycleDescription(lifecycle),
  }));
}

/** Sum a list of per-stage counts (e.g. an workspace row = Σ of its docos). */
export function sumLifecycleCounts(list: readonly LifecycleCounts[]): LifecycleCounts {
  return list.reduce<LifecycleCounts>(
    (acc, c) => ({
      drafting: acc.drafting + c.drafting,
      asserted: acc.asserted + c.asserted,
      retired: acc.retired + c.retired,
    }),
    { drafting: 0, asserted: 0, retired: 0 },
  );
}

/**
 * Picks a readable foreground color (dark or white) for text placed
 * on a lifecycle-colored background. Uses WCAG relative luminance:
 * light backgrounds get dark text; everything else gets white.
 * Returns hex.
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
  return (lifecycle ?? "asserted").replaceAll("_", " ");
}

const NODE_TYPE_PLURAL: Record<string, string> = {
  doco: "docos",
  principal: "principals",
  workspace: "workspaces",
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  guidance_policy: "guidance policies",
  node_authoring_policy: "node-authoring policies",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "references",
};

export function nodeTypePlural(type: string): string {
  return NODE_TYPE_PLURAL[type] ?? `${type}s`;
}
