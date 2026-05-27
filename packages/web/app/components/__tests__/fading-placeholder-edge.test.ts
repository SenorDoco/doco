import { describe, expect, it } from "vitest";
import { getFadingPlaceholderGeometry } from "../fading-placeholder-edge-geometry";

describe("getFadingPlaceholderGeometry", () => {
  it("stops incoming arrow markers before the target handle", () => {
    const geometry = getFadingPlaceholderGeometry({
      sourceX: 0,
      sourceY: 20,
      targetX: 100,
      targetY: 20,
      direction: "incoming",
      hasMarkerEnd: true,
    });

    expect(geometry.endX).toBe(86);
    expect(geometry.endY).toBe(20);
    expect(geometry.path).toContain("86,20");
  });

  it("leaves non-marker placeholder edges pinned to their endpoints", () => {
    const geometry = getFadingPlaceholderGeometry({
      sourceX: 0,
      sourceY: 20,
      targetX: 100,
      targetY: 20,
      direction: "outgoing",
      hasMarkerEnd: false,
    });

    expect(geometry.endX).toBe(100);
    expect(geometry.endY).toBe(20);
    expect(geometry.path).toContain("100,20");
  });
});
