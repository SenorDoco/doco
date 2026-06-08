/**
 * Change detection — client helpers.
 *
 * A Doco's perspective view does NOT live-stream. It renders the node set once
 * and recomputes only on deliberate triggers: cold start, a lifecycle-filter
 * change, a focus change, "view subprocess" / Home in the process perspective,
 * and the viewer's own edits (the user's or Señor Doco's). To stay honest about
 * changes that happen elsewhere (another user, another tab), the page polls a
 * cheap per-Doco "change cursor" (the latest audit_events id; see
 * change-cursor.server.ts) on a relaxed cadence and, when it advances, shows a
 * "new version — Refresh" banner. The graph never reloads on its own; the
 * viewer clicks Refresh (or makes an edit) to pull the new version in.
 */

/** How often the page re-checks the cheap change cursor, in ms. */
export const CHANGE_POLL_INTERVAL_MS = 10_000;

/**
 * Same-tab "the Doco changed" signal. Señor Doco runs in the root-level sidebar
 * — a sibling of the routed Doco page, not a child — and BroadcastChannel does
 * not deliver a tab its own messages, so a settled turn announces itself via
 * this window event. The Doco page listens and revalidates (banner-free) when
 * its own cursor has advanced.
 */
export const DOCO_CHANGED_EVENT = "doco:doco-changed";

/**
 * Whether a freshly-polled cursor means a newer version of the Doco exists than
 * the one currently rendered.
 *
 * True only when the latest cursor is known AND differs from the one the
 * rendered data reflects. A null `latest` (an empty Doco, or a poll that
 * returned nothing) is not a change signal, so it never raises the banner.
 */
export function hasNewVersion(lastSeen: string | null, latest: string | null): boolean {
  return latest !== null && latest !== lastSeen;
}
