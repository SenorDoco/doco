/**
 * Color in Doco encodes *lifecycle stage* only — anywhere, in any
 * perspective or view. Node type is communicated by shape, icon,
 * and text labels; color is reserved so it always means lifecycle.
 * The previous per-type color palette (NODE_TYPE_COLOR / nodeTypeColor)
 * was removed because it competed with the lifecycle stroke and
 * diluted the meaning of color overall.
 */

// Canonical lifecycle has four stages: drafting, queued, active, retired.
// Per project owner the color mapping is, in that order:
//   drafting → yellow (provisional / work in motion)
//   queued   → blue   (ready, waiting to take effect)
//   active   → black  (settled, in force) — formerly `asserted`
//   retired  → red    (no longer in use)
export const LIFECYCLE_COLOR: Record<string, string> = {
  drafting: "#eab308", // yellow-500 — provisional
  queued: "#2563eb", // blue-600 — ready, awaiting activation
  active: "#171717", // gray-900 — settled and in force
  retired: "#dc2626", // red-600 — no longer in use
};

export const LIFECYCLE_FALLBACK_COLOR = "#737373";

export function lifecycleColor(lifecycle: string | null | undefined): string {
  return LIFECYCLE_COLOR[lifecycle ?? "active"] ?? LIFECYCLE_FALLBACK_COLOR;
}

/**
 * One-line explanation of each lifecycle stage, surfaced as the hover
 * title on a colored count so the meaning of each color is discoverable
 * without a separate legend. Wording mirrors the LIFECYCLE_COLOR notes.
 */
export const LIFECYCLE_DESCRIPTION: Record<string, string> = {
  drafting: "Drafting — provisional, work in motion",
  queued: "Queued — ready, waiting to take effect",
  active: "Active — settled, in force",
  retired: "Retired — no longer in use",
};

export function lifecycleDescription(lifecycle: string | null | undefined): string {
  return LIFECYCLE_DESCRIPTION[lifecycle ?? "active"] ?? lifecycleLabel(lifecycle);
}

/**
 * Canonical lifecycle progression. Counts, filter rows, and the stats
 * cards all render the stages in this order so a given color always
 * lands in the same position.
 */
export const LIFECYCLE_ORDER = ["drafting", "queued", "active", "retired"] as const;

/**
 * Render-preference rank for a lifecycle stage: lower = "more live", so
 * `active` sorts first and `retired` last. Use this — NOT `LIFECYCLE_ORDER`,
 * which is the drafting→…→retired *progression* — whenever several entities
 * compete for a single slot and the live one should win. Example: choosing
 * the one `has_parent` edge that places an org-tree seat when a re-point has
 * left an old retired line beside the current active one. Unknown stages sort
 * after the four known ones.
 */
export function lifecycleRenderRank(lifecycle: string | null | undefined): number {
  switch (lifecycle ?? "active") {
    case "active":
      return 0;
    case "queued":
      return 1;
    case "drafting":
      return 2;
    case "retired":
      return 3;
    default:
      return 4;
  }
}

/** A node count broken out by lifecycle stage. */
export interface LifecycleCounts {
  drafting: number;
  queued: number;
  active: number;
  retired: number;
}

export const EMPTY_LIFECYCLE_COUNTS: LifecycleCounts = {
  drafting: 0,
  queued: 0,
  active: 0,
  retired: 0,
};

/**
 * Expand a {@link LifecycleCounts} into canonical-order parts, each
 * tagged with its lifecycle color, ready to render as
 * `drafting / queued / active / retired`. All four stages are always
 * present (zeros included) so a color's position stays stable.
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
  return (lifecycle ?? "active").replaceAll("_", " ");
}

/**
 * Verb that moves an entity INTO each lifecycle stage — the label a lifecycle
 * button shows when it is NOT the current stage ("Draft", "Queue", "Activate",
 * "Retire"). The current stage shows its state name via {@link lifecycleLabel}
 * instead. Shared by the node and edge dialogs so both read "you ARE here /
 * click to GO there."
 */
const LIFECYCLE_VERB: Record<string, string> = {
  drafting: "draft",
  queued: "queue",
  active: "activate",
  retired: "retire",
};

/** Label for a lifecycle button: the state name when current, else the verb. */
export function lifecycleStageLabel(stage: string, isCurrent: boolean): string {
  return isCurrent ? lifecycleLabel(stage) : (LIFECYCLE_VERB[stage] ?? lifecycleLabel(stage));
}

const NODE_TYPE_PLURAL: Record<string, string> = {
  doco: "docos",
  principal: "principals",
  workspace: "workspaces",
  intent: "intents",
  idea: "ideas",
  rule: "rules",
  policy: "policies",
  decision: "decisions",
  action: "actions",
  log: "logs",
  eval: "evals",
  reference: "references",
};

export function nodeTypePlural(type: string): string {
  return NODE_TYPE_PLURAL[type] ?? `${type}s`;
}
