import { describe, expect, it } from "vitest";

import { perspectiveCountLabel } from "../perspective-count";

describe("perspectiveCountLabel", () => {
  it("shows a plain total when nothing is truncated", () => {
    expect(perspectiveCountLabel({ loaded: 427, total: 427 }, "pull request")).toBe(
      "427 pull requests",
    );
  });

  it("shows 'Showing the latest N of M' with thousands separators when truncated", () => {
    expect(perspectiveCountLabel({ loaded: 500, total: 1203 }, "pull request")).toBe(
      "Showing the latest 500 of 1,203 pull requests",
    );
  });

  it("formats large totals with commas", () => {
    expect(perspectiveCountLabel({ loaded: 750, total: 12000 }, "node")).toBe(
      "Showing the latest 750 of 12,000 nodes",
    );
  });

  it("renders zero as a plural empty count", () => {
    expect(perspectiveCountLabel({ loaded: 0, total: 0 }, "pull request")).toBe("0 pull requests");
  });

  it("uses the singular noun when the total is exactly one", () => {
    expect(perspectiveCountLabel({ loaded: 1, total: 1 }, "pull request")).toBe("1 pull request");
  });

  it("keeps the singular noun in the truncated form when the total is one", () => {
    expect(perspectiveCountLabel({ loaded: 0, total: 1 }, "pull request")).toBe(
      "Showing the latest 0 of 1 pull request",
    );
  });

  it("clamps loaded to the total so it never claims to show more than exist", () => {
    expect(perspectiveCountLabel({ loaded: 600, total: 500 }, "pull request")).toBe(
      "500 pull requests",
    );
  });

  it("clamps negative loaded to zero", () => {
    expect(perspectiveCountLabel({ loaded: -5, total: 10 }, "node")).toBe(
      "Showing the latest 0 of 10 nodes",
    );
  });

  it("accepts an explicit plural for irregular nouns", () => {
    expect(perspectiveCountLabel({ loaded: 750, total: 1800 }, "entry", "entries")).toBe(
      "Showing the latest 750 of 1,800 entries",
    );
    expect(perspectiveCountLabel({ loaded: 1, total: 1 }, "entry", "entries")).toBe("1 entry");
  });
});
