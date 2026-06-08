// Shared formatter for a perspective's count headline.
//
// Every perspective that loads a bounded slice describes its dataset with one
// honest line: the TRUE total of its domain (server-computed) and, when the
// slice is smaller than that total, how many of the latest it is showing.
//
// The headline TRACKS THE LIFECYCLE FILTER: the canvas hides the lifecycles the
// page filter turns off (retired by default), so the count counts only the
// lifecycles it shows — otherwise a mostly-retired Doco reads "137 steps" over a
// near-empty canvas. Callers feed `total` from `visibleLifecycleTotal` (the
// per-lifecycle domain totals summed over the visible set) and `loaded` from the
// in-memory filtered slice, so toggling "Retired" on grows both the count and
// the canvas together. Keeping the wording here means "Showing the latest N of
// M …" reads identically across the Pull-requests, List, Approval, Glossary,
// SLA, Org-tree, and BPMN perspectives. Pure.

import type { LifecycleCounts } from "./node-colors";

export interface PerspectiveCountSummary {
  /** Rows actually loaded into the page (the bounded slice). */
  loaded: number;
  /** TRUE total of the perspective's full domain (every row its query matches). */
  total: number;
}

// The four canonical lifecycle stages, matching the keys of LifecycleCounts.
// Local copy so this module stays a pure, dependency-free formatter.
const LIFECYCLE_STAGES: readonly (keyof LifecycleCounts)[] = [
  "drafting",
  "queued",
  "active",
  "retired",
];

/**
 * The visible-lifecycle total: the sum of a domain's per-stage totals over the
 * lifecycles the page filter currently shows. This is what makes a
 * perspective's headline track its canvas — hide "Retired" and the total drops
 * to the active set; toggle it back on and the full total returns. With
 * `visible` omitted/null (no filter wired) every stage counts. A filter entry
 * that isn't a canonical stage contributes nothing. Pure.
 */
export function visibleLifecycleTotal(
  totalByLifecycle: LifecycleCounts,
  visible?: ReadonlySet<string> | null,
): number {
  let sum = 0;
  for (const stage of LIFECYCLE_STAGES) {
    if (!visible || visible.has(stage)) sum += totalByLifecycle[stage] ?? 0;
  }
  return sum;
}

function fmt(n: number): string {
  // Pin the locale so thousands separators are deterministic in tests and
  // identical across machines ("1,203", not "1.203" or "1 203").
  return Math.trunc(n).toLocaleString("en-US");
}

/**
 * Build a perspective's count headline.
 *
 * - `total <= loaded` (nothing truncated): `"<total> <noun>"`.
 * - `total > loaded`  (bounded slice):     `"Showing the latest <loaded> of <total> <noun>"`.
 *
 * `loaded` is clamped to `[0, total]`, so a transient over-count can never print
 * "Showing the latest 600 of 500". The noun agrees with `total`; pass an
 * explicit `plural` for irregular nouns (e.g. "entry" → "entries").
 */
export function perspectiveCountLabel(
  summary: PerspectiveCountSummary,
  singular: string,
  plural = `${singular}s`,
): string {
  const total = Math.max(0, Math.trunc(summary.total));
  const loaded = Math.max(0, Math.min(Math.trunc(summary.loaded), total));
  const noun = total === 1 ? singular : plural;
  if (loaded < total) {
    return `Showing the latest ${fmt(loaded)} of ${fmt(total)} ${noun}`;
  }
  return `${fmt(total)} ${noun}`;
}
