import { describe, expect, it } from "vitest";
import { overviewNodeDisplayLabel } from "../overview-graph-labels";

describe("overviewNodeDisplayLabel", () => {
  it("keeps the base graph label when detail data arrives for reference numbers", () => {
    expect(
      overviewNodeDisplayLabel(
        {
          id: "reference_01TEST00000000000000001",
          node_type: "reference",
          name: "Canonical Doco agent protocol",
        },
        {
          name: "https://doco.to/protocol/canonical-instructions",
          summary: "Canonical Doco agent protocol",
        },
      ),
    ).toBe("Canonical Doco agent protocol");
  });
});
