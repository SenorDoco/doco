import { describe, expect, it } from "vitest";
import { opacityForDepth } from "../graph-depth";

describe("opacityForDepth", () => {
  it("keeps the focused node solid, then fades by degree", () => {
    expect(opacityForDepth(0)).toBe(1);
    expect(opacityForDepth(1)).toBe(0.75);
    expect(opacityForDepth(2)).toBe(0.5);
    expect(opacityForDepth(3)).toBe(0.25);
    expect(opacityForDepth(4)).toBe(0.25);
    expect(opacityForDepth(undefined)).toBe(0.25);
  });
});
