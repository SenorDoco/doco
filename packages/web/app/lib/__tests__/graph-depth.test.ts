import { describe, expect, it } from "vitest";
import { opacityForDepth } from "../graph-depth";

describe("opacityForDepth", () => {
  it("keeps focal and first-degree neurons prominent, then fades sharply", () => {
    expect(opacityForDepth(0)).toBe(0.8);
    expect(opacityForDepth(1)).toBe(0.8);
    expect(opacityForDepth(2)).toBe(0.4);
    expect(opacityForDepth(3)).toBe(0.2);
    expect(opacityForDepth(4)).toBe(0.2);
    expect(opacityForDepth(undefined)).toBe(0.2);
  });
});
