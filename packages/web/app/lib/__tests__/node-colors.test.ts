import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_COLOR,
  LIFECYCLE_DESCRIPTION,
  lifecycleColor,
  lifecycleCountParts,
  lifecycleDescription,
} from "../node-colors";

describe("LIFECYCLE_COLOR", () => {
  it("paints queued blue and drafting yellow", () => {
    expect(LIFECYCLE_COLOR.queued).toBe("#2563eb"); // blue-600
    expect(LIFECYCLE_COLOR.drafting).toBe("#eab308"); // yellow-500
  });

  it("keeps active black and retired red", () => {
    expect(LIFECYCLE_COLOR.active).toBe("#171717"); // gray-900
    expect(LIFECYCLE_COLOR.retired).toBe("#dc2626"); // red-600
  });

  it("resolves the same colors through lifecycleColor()", () => {
    expect(lifecycleColor("queued")).toBe("#2563eb");
    expect(lifecycleColor("drafting")).toBe("#eab308");
  });
});

describe("lifecycleCountParts", () => {
  it("returns each stage in canonical order with its color and hover title", () => {
    expect(lifecycleCountParts({ drafting: 1, queued: 7, active: 33, retired: 2 })).toEqual([
      {
        lifecycle: "drafting",
        count: 1,
        color: LIFECYCLE_COLOR.drafting,
        title: LIFECYCLE_DESCRIPTION.drafting,
      },
      {
        lifecycle: "queued",
        count: 7,
        color: LIFECYCLE_COLOR.queued,
        title: LIFECYCLE_DESCRIPTION.queued,
      },
      {
        lifecycle: "active",
        count: 33,
        color: LIFECYCLE_COLOR.active,
        title: LIFECYCLE_DESCRIPTION.active,
      },
      {
        lifecycle: "retired",
        count: 2,
        color: LIFECYCLE_COLOR.retired,
        title: LIFECYCLE_DESCRIPTION.retired,
      },
    ]);
  });

  it("always represents all four stages, even when a count is zero", () => {
    const parts = lifecycleCountParts({ drafting: 0, queued: 0, active: 0, retired: 0 });
    expect(parts.map((p) => p.lifecycle)).toEqual(["drafting", "queued", "active", "retired"]);
    expect(parts.map((p) => p.count)).toEqual([0, 0, 0, 0]);
  });
});

describe("lifecycleDescription", () => {
  it("explains each stage by name", () => {
    expect(lifecycleDescription("drafting")).toMatch(/^Drafting\b/);
    expect(lifecycleDescription("queued")).toMatch(/^Queued\b/);
    expect(lifecycleDescription("active")).toMatch(/^Active\b/);
    expect(lifecycleDescription("retired")).toMatch(/^Retired\b/);
  });

  it("defaults a null/undefined lifecycle to the active description", () => {
    expect(lifecycleDescription(null)).toBe(LIFECYCLE_DESCRIPTION.active);
    expect(lifecycleDescription(undefined)).toBe(LIFECYCLE_DESCRIPTION.active);
  });
});
