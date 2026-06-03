import { describe, expect, it } from "vitest";
import { opacityForDepth, opacityForEdge } from "../graph-depth";

describe("opacityForDepth", () => {
  it("keeps the focused node solid, then fades each ring by 25%", () => {
    expect(opacityForDepth(0)).toBe(1);
    expect(opacityForDepth(1)).toBe(0.75);
    expect(opacityForDepth(2)).toBe(0.5);
    expect(opacityForDepth(3)).toBe(0.25);
    expect(opacityForDepth(4)).toBe(0.25);
    expect(opacityForDepth(undefined)).toBe(0.25);
  });
});

describe("opacityForEdge", () => {
  it("renders each edge one ring brighter than its deeper endpoint", () => {
    // 1st-degree edges (deeper endpoint one hop out) stay fully solid —
    // the arrows leaving the focal node read as solid as the focus.
    expect(opacityForEdge(0, 1)).toBe(1);
    expect(opacityForEdge(1, 1)).toBe(1);
    // 2nd-degree edges → 75% (one ring brighter than a 2-hop node's 50%).
    expect(opacityForEdge(1, 2)).toBe(0.75);
    expect(opacityForEdge(2, 2)).toBe(0.75);
    // 3rd-degree edges → 50%.
    expect(opacityForEdge(2, 3)).toBe(0.5);
    expect(opacityForEdge(3, 3)).toBe(0.5);
    // 4th-degree edges and deeper → the 25% floor.
    expect(opacityForEdge(3, 4)).toBe(0.25);
    expect(opacityForEdge(4, 5)).toBe(0.25);
  });

  it("is symmetric in its endpoints", () => {
    expect(opacityForEdge(2, 1)).toBe(opacityForEdge(1, 2));
    expect(opacityForEdge(4, 3)).toBe(opacityForEdge(3, 4));
  });

  it("floors unreachable edges at 25%", () => {
    expect(opacityForEdge(undefined, undefined)).toBe(0.25);
    // A single unreachable endpoint still floors the whole edge.
    expect(opacityForEdge(1, undefined)).toBe(0.25);
    expect(opacityForEdge(undefined, 2)).toBe(0.25);
  });
});
