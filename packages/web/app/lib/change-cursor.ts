/**
 * Live-feed change cursor — client helpers (ADR-089, real-time refinement).
 *
 * A Doco's perspective view stays fresh by polling a cheap per-Doco "change
 * cursor" (the latest audit_events id; see change-cursor.server.ts) and only
 * re-running the heavy perspective loader when that cursor advances.
 *
 * Why gate instead of just polling the loader faster: re-running the loader on
 * every tick re-renders the interactive graph, which makes it stutter while you
 * pan or navigate. Gating on the cursor means an idle perspective never
 * re-renders, so navigation stays smooth — and when something does change the
 * update lands within one poll interval, near-real-time.
 */

/** How often the client re-checks the cheap change cursor, in ms. */
export const CHANGE_POLL_INTERVAL_MS = 1000;

/**
 * Decide whether a freshly-polled cursor means the rendered perspective is
 * stale and should be revalidated.
 *
 * Revalidate only when the latest cursor is known AND differs from the one the
 * current data reflects. A null `latest` (an empty Doco, or a poll that
 * returned nothing) is not a change signal, so it never triggers a reload.
 */
export function shouldRevalidateForCursor(lastSeen: string | null, latest: string | null): boolean {
  return latest !== null && latest !== lastSeen;
}
