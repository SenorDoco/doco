import { Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { getStreetBezierPath } from "../stable-labeled-edge-path";

describe("getStreetBezierPath", () => {
  it("rounds separated forward bends with a 14px curve radius", () => {
    const [path, labelX, labelY] = getStreetBezierPath({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 140,
      targetY: 56,
      targetPosition: Position.Left,
    });

    expect(path).toContain("Q 70,0 70,14");
    expect(path).toContain("Q 70,56 84,56");
    expect(path).not.toContain(" C ");
    expect(labelX).toBe(70);
    expect(labelY).toBe(28);
  });

  it("routes tight U-turns through 14px rounded detours", () => {
    const [path] = getStreetBezierPath({
      sourceX: 100,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 80,
      targetY: 0,
      targetPosition: Position.Left,
    });

    expect(path).toContain("Q 142,0 142,14");
    expect(path).toContain("Q 142,56 128,56");
    expect(path).toContain("Q 66,0 80,0");
    expect(path).not.toContain(" C ");
  });

  it("keeps already aligned edges straight instead of adding needless curves", () => {
    const [path] = getStreetBezierPath({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 100,
      targetY: 0,
      targetPosition: Position.Left,
    });

    expect(path).toBe("M 0,0 L 14,0 L 86,0 L 100,0");
  });
});
