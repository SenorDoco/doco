// Pure decision logic for the live-feed change cursor (ADR-089, real-time
// refinement). The perspective view polls a cheap per-Doco cursor every second
// and only re-runs its heavy loader when the cursor advances; this is the
// gate that keeps the graph from re-rendering on every idle tick.

import { describe, expect, it } from "vitest";
import { CHANGE_POLL_INTERVAL_MS, shouldRevalidateForCursor } from "../change-cursor";

describe("shouldRevalidateForCursor", () => {
  it("does not revalidate when the cursor is unchanged", () => {
    expect(shouldRevalidateForCursor("event_a", "event_a")).toBe(false);
  });

  it("revalidates when the cursor advances to a new event", () => {
    expect(shouldRevalidateForCursor("event_a", "event_b")).toBe(true);
  });

  it("treats a null poll result as no change (never a spurious reload)", () => {
    expect(shouldRevalidateForCursor("event_a", null)).toBe(false);
    expect(shouldRevalidateForCursor(null, null)).toBe(false);
  });

  it("revalidates when a first change appears in a previously empty Doco", () => {
    expect(shouldRevalidateForCursor(null, "event_a")).toBe(true);
  });
});

describe("CHANGE_POLL_INTERVAL_MS", () => {
  it("polls about once a second — near-real-time but cheap to sustain", () => {
    expect(CHANGE_POLL_INTERVAL_MS).toBeLessThanOrEqual(1000);
    expect(CHANGE_POLL_INTERVAL_MS).toBeGreaterThan(0);
  });
});
