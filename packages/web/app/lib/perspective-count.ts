// Shared formatter for a perspective's count headline.
//
// Every perspective that loads a bounded slice describes its dataset with one
// honest line: the TRUE total of its domain (server-computed) and, when the
// slice is smaller than that total, how many of the latest it is showing.
//
// The headline is about the DATASET, never about the client-side lifecycle
// filter — that filter's effect belongs in per-group / per-row counts. Keeping
// the wording here means "Showing the latest N of M …" reads identically across
// the Pull-requests, List, Approval, Glossary, SLA, Org-tree, and BPMN
// perspectives. Pure.

export interface PerspectiveCountSummary {
  /** Rows actually loaded into the page (the bounded slice). */
  loaded: number;
  /** TRUE total of the perspective's full domain (every row its query matches). */
  total: number;
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
