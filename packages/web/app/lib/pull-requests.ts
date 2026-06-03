// Client-safe Pull-requests view helpers — shared by the server loader
// (pull-requests-perspective.server.ts), the Doco home route, and the
// perspective UI. Deliberately free of any DB or server-only import so it can
// be bundled into the client (the route's filter checkboxes live there).
//
// A PR's canonical lifecycle stage maps to a GitHub-flavored state label:
//   queued → Open, active → Merged, retired → Closed.
// Anything else displays as Open — the catch-all — matching how the loader
// normalizes off-canonical/unknown stages.

/**
 * The PR lifecycle stages a Doco surfaces, in display order. "drafting" is
 * intentionally absent: a pull request is never in that stage, so it never
 * appears as a Pull-requests filter chip.
 */
export const PR_LIFECYCLE_ORDER = ["queued", "active", "retired"] as const;

const PR_LIFECYCLE_LABELS: Record<string, string> = {
  queued: "Open",
  active: "Merged",
  retired: "Closed",
};

/** Display label for a PR's lifecycle chip (Open / Merged / Closed). */
export function pullRequestLabel(lifecycle: string): string {
  return PR_LIFECYCLE_LABELS[lifecycle] ?? PR_LIFECYCLE_LABELS.queued;
}

/**
 * Parse the `pr_lifecycle` URL param into the selected stages.
 *
 * - `null` (param absent) → `null`, meaning "all stages" — the default,
 *   unfiltered view, so existing links keep showing every PR.
 * - a present value (including the empty string) → the explicit, whitelisted,
 *   canonically-ordered subset (which may be empty, meaning "none selected").
 *
 * Unknown tokens are dropped and duplicates collapsed, so a hand-edited URL
 * can never smuggle an arbitrary value into the filter. Pure.
 */
export function parsePrLifecycles(param: string | null): string[] | null {
  if (param === null) return null;
  const allowed = new Set<string>(PR_LIFECYCLE_ORDER);
  const seen = new Set<string>();
  for (const token of param.split(",")) {
    const stage = token.trim();
    if (allowed.has(stage)) seen.add(stage);
  }
  return PR_LIFECYCLE_ORDER.filter((stage) => seen.has(stage));
}

/**
 * The stages whose checkbox should read as checked, given the URL param. An
 * absent param shows every stage checked (the default). Pure.
 */
export function visiblePrLifecycles(param: string | null): Set<string> {
  return new Set(parsePrLifecycles(param) ?? PR_LIFECYCLE_ORDER);
}

/**
 * Compute the next `pr_lifecycle` param value after toggling one stage.
 * Returns `null` when the param should be dropped from the URL (every stage
 * selected → the clean, default address). A strict subset is returned as a
 * canonically-ordered comma list, and "none selected" as the empty string.
 *
 * Keeping the filter state in the URL is what makes it stick: the live feed's
 * revalidation re-runs the loader with the same address, so unlike the old
 * page-level filter there is no re-seed to flip the user's choice back. Pure.
 */
export function togglePrLifecycleParam(param: string | null, stage: string): string | null {
  if (!(PR_LIFECYCLE_ORDER as readonly string[]).includes(stage)) return param;
  const next = visiblePrLifecycles(param);
  if (next.has(stage)) next.delete(stage);
  else next.add(stage);
  if (PR_LIFECYCLE_ORDER.every((s) => next.has(s))) return null;
  return PR_LIFECYCLE_ORDER.filter((s) => next.has(s)).join(",");
}
