import { describe, expect, it } from "vitest";
import { layoutOutsideNodes } from "../bpmn-outside-layout";

const opts = { originX: 1000, focalY: 0, columnGap: 50, rowGap: 20 };

describe("layoutOutsideNodes", () => {
  it("returns nothing for an empty outsider set", () => {
    expect(layoutOutsideNodes([], new Map(), opts).size).toBe(0);
  });

  it("places closer nodes (smaller graph distance) in earlier columns", () => {
    const outsiders = [
      { id: "far", width: 100, height: 40 },
      { id: "near", width: 100, height: 40 },
    ];
    const depth = new Map([
      ["near", 1],
      ["far", 3],
    ]);
    const positions = layoutOutsideNodes(outsiders, depth, opts);
    const near = positions.get("near");
    const far = positions.get("far");
    expect(near).toBeDefined();
    expect(far).toBeDefined();
    // Distance band drives the column: nearer node sits left of the farther one.
    expect((near as { x: number }).x).toBeLessThan((far as { x: number }).x);
    // Closest band starts at originX.
    expect((near as { x: number }).x).toBe(1000);
  });

  it("stacks same-band nodes vertically, centered on the focal y", () => {
    const outsiders = [
      { id: "a", width: 100, height: 40 },
      { id: "b", width: 100, height: 40 },
    ];
    const depth = new Map([
      ["a", 1],
      ["b", 1],
    ]);
    const positions = layoutOutsideNodes(outsiders, depth, { ...opts, focalY: 0 });
    const a = positions.get("a") as { x: number; y: number };
    const b = positions.get("b") as { x: number; y: number };
    // Same band → same column x.
    expect(a.x).toBe(b.x);
    // Two 40px nodes with a 20px gap span 100px, centered on y=0 → -50..50.
    const ys = [a.y, b.y].sort((m, n) => m - n);
    expect(ys[0]).toBe(-50);
    expect(ys[1]).toBe(10); // -50 + 40 + 20
  });

  it("puts unreachable nodes in the outermost band", () => {
    const outsiders = [
      { id: "reachable", width: 100, height: 40 },
      { id: "orphan", width: 100, height: 40 },
    ];
    const depth = new Map([["reachable", 1]]);
    const positions = layoutOutsideNodes(outsiders, depth, opts);
    const reachable = positions.get("reachable") as { x: number };
    const orphan = positions.get("orphan") as { x: number };
    expect(orphan.x).toBeGreaterThan(reachable.x);
  });

  it("is deterministic for ties within a band (sorted by id)", () => {
    const outsiders = [
      { id: "z", width: 100, height: 40 },
      { id: "a", width: 100, height: 40 },
    ];
    const depth = new Map([
      ["z", 2],
      ["a", 2],
    ]);
    const positions = layoutOutsideNodes(outsiders, depth, { ...opts, focalY: 0 });
    const a = positions.get("a") as { y: number };
    const z = positions.get("z") as { y: number };
    // `a` sorts before `z`, so it takes the top slot.
    expect(a.y).toBeLessThan(z.y);
  });
});
