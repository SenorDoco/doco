import { describe, expect, it } from "vitest";
import { layoutAdjacentNodes } from "../process-outside-layout";

const opts = { centerX: 500, poolTopY: 100, poolBottomY: 300, gap: 40, columnGap: 20 };

describe("layoutAdjacentNodes", () => {
  it("returns nothing for an empty set", () => {
    expect(layoutAdjacentNodes([], opts).size).toBe(0);
  });

  it("places an 'above' node above the pool's top edge", () => {
    const positions = layoutAdjacentNodes(
      [{ id: "n", width: 100, height: 60, side: "above" }],
      opts,
    );
    const n = positions.get("n") as { x: number; y: number };
    // y = poolTopY - gap - height = 100 - 40 - 60 = 0
    expect(n.y).toBe(0);
    // Single node centered on centerX: x = 500 - 100/2 = 450
    expect(n.x).toBe(450);
  });

  it("places a 'below' node under the pool's bottom edge", () => {
    const positions = layoutAdjacentNodes(
      [{ id: "n", width: 100, height: 60, side: "below" }],
      opts,
    );
    const n = positions.get("n") as { y: number };
    // y = poolBottomY + gap = 300 + 40 = 340
    expect(n.y).toBe(340);
  });

  it("lays multiple same-side nodes in a horizontal row centered on centerX", () => {
    const positions = layoutAdjacentNodes(
      [
        { id: "a", width: 100, height: 60, side: "above" },
        { id: "b", width: 100, height: 60, side: "above" },
      ],
      opts,
    );
    const a = positions.get("a") as { x: number; y: number };
    const b = positions.get("b") as { x: number; y: number };
    // Same side → same y, laid left→right.
    expect(a.y).toBe(b.y);
    expect(b.x).toBeGreaterThan(a.x);
    // Row total width = 100 + 20 + 100 = 220, centered on 500 → starts at 390.
    expect(a.x).toBe(390);
    expect(b.x).toBe(390 + 100 + 20);
  });

  it("separates 'above' and 'below' rows onto opposite edges", () => {
    const positions = layoutAdjacentNodes(
      [
        { id: "up", width: 100, height: 60, side: "above" },
        { id: "down", width: 100, height: 60, side: "below" },
      ],
      opts,
    );
    const up = positions.get("up") as { y: number };
    const down = positions.get("down") as { y: number };
    expect(up.y).toBeLessThan(opts.poolTopY);
    expect(down.y).toBeGreaterThan(opts.poolBottomY);
  });

  it("orders a row deterministically by id", () => {
    const positions = layoutAdjacentNodes(
      [
        { id: "z", width: 100, height: 60, side: "below" },
        { id: "a", width: 100, height: 60, side: "below" },
      ],
      opts,
    );
    const a = positions.get("a") as { x: number };
    const z = positions.get("z") as { x: number };
    expect(a.x).toBeLessThan(z.x);
  });
});
