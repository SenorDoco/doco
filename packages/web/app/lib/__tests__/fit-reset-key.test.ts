import { describe, expect, it } from "vitest";
import { fitResetKey } from "../fit-reset-key";

describe("fitResetKey", () => {
  it("changes when the change cursor advances (a revalidation — fresh nodes/edges)", () => {
    const before = fitResetKey("event_a", ["active"]);
    const after = fitResetKey("event_b", ["active"]);
    expect(after).not.toBe(before);
  });

  it("changes when the lifecycle filter changes (trigger b)", () => {
    const before = fitResetKey("event_a", ["active"]);
    const after = fitResetKey("event_a", ["active", "retired"]);
    expect(after).not.toBe(before);
  });

  it("is stable across calls with the same data and filter — so focus never resets the camera", () => {
    // The key has no focus/center input by design: focusing a node (trigger c)
    // changes neither the cursor nor the filter, so the key — and the camera —
    // stays put.
    expect(fitResetKey("event_a", ["active", "queued"])).toBe(
      fitResetKey("event_a", ["active", "queued"]),
    );
  });

  it("ignores lifecycle ordering — the same set yields the same key", () => {
    expect(fitResetKey("event_a", ["retired", "active"])).toBe(
      fitResetKey("event_a", ["active", "retired"]),
    );
  });

  it("treats a null cursor (empty Doco) as a stable, valid key", () => {
    expect(fitResetKey(null, ["active"])).toBe(fitResetKey(null, ["active"]));
    expect(fitResetKey(null, ["active"])).not.toBe(fitResetKey("event_a", ["active"]));
  });
});
