import { describe, expect, it } from "vitest";
import {
  EMPTY_LIFECYCLE_COUNTS,
  LIFECYCLE_COLOR,
  lifecycleCountParts,
  sumLifecycleCounts,
} from "../node-colors";

describe("lifecycleCountParts", () => {
  it("returns drafting, asserted, retired in canonical order with their colors", () => {
    expect(lifecycleCountParts({ drafting: 1, asserted: 33, retired: 2 })).toEqual([
      { lifecycle: "drafting", count: 1, color: LIFECYCLE_COLOR.drafting },
      { lifecycle: "asserted", count: 33, color: LIFECYCLE_COLOR.asserted },
      { lifecycle: "retired", count: 2, color: LIFECYCLE_COLOR.retired },
    ]);
  });

  it("always represents all three stages, even when a count is zero", () => {
    const parts = lifecycleCountParts({ drafting: 0, asserted: 0, retired: 0 });
    expect(parts.map((p) => p.lifecycle)).toEqual(["drafting", "asserted", "retired"]);
    expect(parts.map((p) => p.count)).toEqual([0, 0, 0]);
  });
});

describe("sumLifecycleCounts", () => {
  it("sums each lifecycle stage independently across entries", () => {
    expect(
      sumLifecycleCounts([
        { drafting: 1, asserted: 2, retired: 3 },
        { drafting: 10, asserted: 20, retired: 30 },
      ]),
    ).toEqual({ drafting: 11, asserted: 22, retired: 33 });
  });

  it("returns an all-zero total for an empty list", () => {
    expect(sumLifecycleCounts([])).toEqual(EMPTY_LIFECYCLE_COUNTS);
  });
});
