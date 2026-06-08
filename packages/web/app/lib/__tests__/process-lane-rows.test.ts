import { describe, expect, it } from "vitest";
import { type LaneRowNode, computeLaneRowCenters } from "../process-lane-rows";

const row = (id: string, column: number, alignTo?: string): LaneRowNode => ({
  id,
  column,
  height: 60,
  alignTo,
});

describe("computeLaneRowCenters", () => {
  it("draws a single-predecessor node at its predecessor's vertical center", () => {
    // Two roots stack in column 0 (a1 above center, a2 below); b's only
    // forward predecessor is a1, so b lands on a1's line — not the lane center.
    const centers = computeLaneRowCenters([row("a1", 0), row("a2", 0), row("b", 1, "a1")], 300, 40);
    expect(centers.get("a1")).toBe(100);
    expect(centers.get("a2")).toBe(200);
    expect(centers.get("b")).toBe(centers.get("a1"));
    // The lane center is 150 — proof b followed its predecessor up rather
    // than re-centering on its own column.
    expect(centers.get("b")).not.toBe(150);
  });

  it("spreads two nodes that share one anchor symmetrically around it", () => {
    // c and d both follow a — they cannot both sit on a's line, so they
    // split evenly above and below it without overlapping.
    const centers = computeLaneRowCenters(
      [row("a", 0), row("c", 1, "a"), row("d", 1, "a")],
      300,
      40,
    );
    expect(centers.get("a")).toBe(150);
    expect(centers.get("c")).toBe(100);
    expect(centers.get("d")).toBe(200);
    // Centers stay at least one node + gap apart (60/2 + 60/2 + 40 = 100).
    expect((centers.get("d") as number) - (centers.get("c") as number)).toBeGreaterThanOrEqual(100);
  });

  it("centers an un-anchored column like the previous stacked layout", () => {
    const centers = computeLaneRowCenters([row("a", 0), row("b", 0), row("c", 0)], 400, 40);
    expect(centers.get("a")).toBe(100);
    expect(centers.get("b")).toBe(200);
    expect(centers.get("c")).toBe(300);
  });

  it("falls back to the lane center when the anchor is missing", () => {
    const centers = computeLaneRowCenters([row("a", 1, "ghost")], 200, 40);
    expect(centers.get("a")).toBe(100);
  });

  it("chains alignment down a linear flow across columns", () => {
    // a (top of column 0) → b → c: the whole chain rides a's line.
    const centers = computeLaneRowCenters(
      [row("a", 0), row("z", 0), row("b", 1, "a"), row("c", 2, "b")],
      300,
      40,
    );
    expect(centers.get("a")).toBe(100);
    expect(centers.get("b")).toBe(100);
    expect(centers.get("c")).toBe(100);
  });
});
