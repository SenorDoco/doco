import { Position, getBezierPath } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { BACKWARD_LOOP_BOW, getStableEdgePath } from "../stable-labeled-edge-geometry";

const RIGHT = Position.Right;
const LEFT = Position.Left;

describe("getStableEdgePath", () => {
  it("routes an ordinary forward edge as React Flow's plain bezier", () => {
    const edge = {
      sourceX: 0,
      sourceY: 0,
      sourcePosition: RIGHT,
      targetX: 200,
      targetY: 40,
      targetPosition: LEFT,
    };
    expect(getStableEdgePath(edge)[0]).toBe(getBezierPath(edge)[0]);
  });

  it("draws a well-separated backward edge as the same bezier — one curve family, no squared route", () => {
    // Target sits left of and far below its source — the #9 → #10 case. Far
    // enough apart that no loop bow is needed, so it is exactly the plain
    // bezier (a single cubic), not an orthogonal smoothstep.
    const edge = {
      sourceX: 300,
      sourceY: 0,
      sourcePosition: RIGHT,
      targetX: 0,
      targetY: 400,
      targetPosition: LEFT,
    };
    const [path] = getStableEdgePath(edge);
    expect(path).toBe(getBezierPath(edge)[0]);
    expect(path).not.toContain("L"); // a cubic, not orthogonal segments
  });

  it("bows a near-same-row backward loop into a curve below both endpoints, never a flat cusp", () => {
    const edge = {
      sourceX: 300,
      sourceY: 100,
      sourcePosition: RIGHT,
      targetX: 0,
      targetY: 100,
      targetPosition: LEFT,
    };
    const [path] = getStableEdgePath(edge);
    // Still a single cubic in the same family as every other edge…
    expect(path.startsWith("M300,100 C")).toBe(true);
    expect(path).not.toContain("L");
    // …but bowed, so it is not the cusp-folding plain bezier…
    expect(path).not.toBe(getBezierPath(edge)[0]);
    // …and its control points dip a full loop height below both endpoints.
    expect(path).toContain(`,${100 + BACKWARD_LOOP_BOW}`);
  });

  it("arcs a forward edge over a blocking node when the layout sets a bow", () => {
    const edge = {
      sourceX: 0,
      sourceY: 0,
      sourcePosition: RIGHT,
      targetX: 200,
      targetY: 0,
      targetPosition: LEFT,
      bowLift: 40,
      bowDir: -1 as const,
    };
    const [path, , labelY] = getStableEdgePath(edge);
    expect(path.startsWith("M0,0 C")).toBe(true);
    expect(labelY).toBeLessThan(0);
  });
});
