// Pure decision logic for change detection. The perspective view polls a cheap
// per-Doco cursor and, when it advances, surfaces a "new version — Refresh"
// banner instead of auto-reloading the graph. The same predicate also gates the
// immediate, banner-free revalidation that follows the user's or Señor Doco's
// own edits (the only writes we know changed this view). See change-cursor.ts.

import { describe, expect, it } from "vitest";
import { CHANGE_POLL_INTERVAL_MS, DOCO_CHANGED_EVENT, hasNewVersion } from "../change-cursor";

describe("hasNewVersion", () => {
  it("reports no new version when the cursor is unchanged", () => {
    expect(hasNewVersion("event_a", "event_a")).toBe(false);
  });

  it("reports a new version when the cursor advances to a new event", () => {
    expect(hasNewVersion("event_a", "event_b")).toBe(true);
  });

  it("treats a null poll result as no change (never a spurious banner)", () => {
    expect(hasNewVersion("event_a", null)).toBe(false);
    expect(hasNewVersion(null, null)).toBe(false);
  });

  it("reports a new version when a first change appears in a previously empty Doco", () => {
    expect(hasNewVersion(null, "event_a")).toBe(true);
  });
});

describe("CHANGE_POLL_INTERVAL_MS", () => {
  it("is a relaxed cadence — only feeds a manual-refresh banner, never streams the graph", () => {
    // No longer near-real-time (the old 1s tick re-rendered the graph). The
    // poll now only toggles a banner, so a relaxed interval is plenty and
    // keeps idle tabs cheap.
    expect(CHANGE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(CHANGE_POLL_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("DOCO_CHANGED_EVENT", () => {
  it("is a stable window event name shared by the agent sidebar and the Doco page", () => {
    // Señor Doco runs in the root-level sidebar (a sibling of the routed
    // page), so it signals a settled turn same-tab via this window event;
    // the Doco page listens and revalidates if its own cursor advanced.
    expect(DOCO_CHANGED_EVENT).toBe("doco:doco-changed");
  });
});
