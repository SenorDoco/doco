import { describe, expect, it } from "vitest";
import { type LaneRowNode, computeLaneRowCenters } from "../process-lane-rows";

const row = (id: string, column: number, predecessors: string[] = [], order = 0): LaneRowNode => ({
  id,
  column,
  height: 60,
  predecessors,
  order,
});

describe("computeLaneRowCenters", () => {
  it("draws a single-predecessor node on its predecessor's line", () => {
    // Two roots stack in column 0 (a1 above center, a2 below); b's only
    // predecessor is a1, so b lands on a1's line — not the lane center.
    const centers = computeLaneRowCenters(
      [row("a1", 0, [], 0), row("a2", 0, [], 1), row("b", 1, ["a1"])],
      300,
      40,
    );
    expect(centers.get("a1")).toBe(100);
    expect(centers.get("a2")).toBe(200);
    expect(centers.get("b")).toBe(centers.get("a1"));
    expect(centers.get("b")).not.toBe(150);
  });

  it("spreads two nodes that share one anchor symmetrically around it", () => {
    const centers = computeLaneRowCenters(
      [row("a", 0), row("c", 1, ["a"], 0), row("d", 1, ["a"], 1)],
      300,
      40,
    );
    expect(centers.get("a")).toBe(150);
    expect(centers.get("c")).toBe(100);
    expect(centers.get("d")).toBe(200);
    expect((centers.get("d") as number) - (centers.get("c") as number)).toBeGreaterThanOrEqual(100);
  });

  it("centers an un-anchored column like the previous stacked layout", () => {
    const centers = computeLaneRowCenters(
      [row("a", 0, [], 0), row("b", 0, [], 1), row("c", 0, [], 2)],
      400,
      40,
    );
    expect(centers.get("a")).toBe(100);
    expect(centers.get("b")).toBe(200);
    expect(centers.get("c")).toBe(300);
  });

  it("sits a merge node at the midpoint of its predecessors", () => {
    const centers = computeLaneRowCenters(
      [row("a1", 0, [], 0), row("a2", 0, [], 1), row("m", 1, ["a1", "a2"])],
      300,
      40,
    );
    // a1 at 100, a2 at 200 → m averages to the line between them.
    expect(centers.get("m")).toBe(150);
  });

  it("orders a column by the flow, not creation order, to avoid crossings", () => {
    // top→x and bottom→y, but x was created before y. If the column kept
    // creation order, x (wanting the bottom line) would sit above y (wanting
    // the top line) and the solver would pool both to the center, undoing the
    // alignment. Ordering by the flow lets each ride its own predecessor.
    const centers = computeLaneRowCenters(
      [
        row("top", 0, [], 0),
        row("bottom", 0, [], 1),
        row("x", 1, ["bottom"], 0),
        row("y", 1, ["top"], 1),
      ],
      300,
      40,
    );
    expect(centers.get("top")).toBe(100);
    expect(centers.get("bottom")).toBe(200);
    expect(centers.get("y")).toBe(100);
    expect(centers.get("x")).toBe(200);
  });

  it("falls back to the lane center when no predecessor is placed", () => {
    const centers = computeLaneRowCenters([row("a", 1, ["ghost"])], 200, 40);
    expect(centers.get("a")).toBe(100);
  });

  it("chains alignment down a linear flow across columns", () => {
    const centers = computeLaneRowCenters(
      [row("a", 0, [], 0), row("z", 0, [], 1), row("b", 1, ["a"]), row("c", 2, ["b"])],
      300,
      40,
    );
    expect(centers.get("a")).toBe(100);
    expect(centers.get("b")).toBe(100);
    expect(centers.get("c")).toBe(100);
  });
});
