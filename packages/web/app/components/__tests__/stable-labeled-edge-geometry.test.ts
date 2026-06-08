import { Position, getBezierPath, getSmoothStepPath } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  BACKWARD_EDGE_RADIUS,
  BACKWARD_LOOP_DROP,
  getStableEdgePath,
} from "../stable-labeled-edge-geometry";

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

  it("routes a long backward edge as a rounded smoothstep, not a folding bezier", () => {
    // Target sits left of and far below its source — the #9 → #10 case.
    const edge = {
      sourceX: 300,
      sourceY: 0,
      sourcePosition: RIGHT,
      targetX: 0,
      targetY: 400,
      targetPosition: LEFT,
    };
    const [path] = getStableEdgePath(edge);
    expect(path).toBe(getSmoothStepPath({ ...edge, borderRadius: BACKWARD_EDGE_RADIUS })[0]);
    expect(path).not.toBe(getBezierPath(edge)[0]);
  });

  it("drops a near-same-row backward loop below both endpoints so it never folds flat", () => {
    // Same row, target left of source — a tight feedback loop. A plain
    // bezier (or default smoothstep) collapses onto the node row; this must
    // dip below both endpoints to stay readable.
    const edge = {
      sourceX: 300,
      sourceY: 100,
      sourcePosition: RIGHT,
      targetX: 0,
      targetY: 100,
      targetPosition: LEFT,
    };
    const detourY = 100 + BACKWARD_LOOP_DROP;
    const [path] = getStableEdgePath(edge);
    expect(path).toBe(
      getSmoothStepPath({ ...edge, borderRadius: BACKWARD_EDGE_RADIUS, centerY: detourY })[0],
    );
    // The forced detour: the route reaches a Y below both endpoints…
    expect(path).toContain(String(detourY));
    // …unlike the default smoothstep, which would run flat along the row.
    expect(path).not.toBe(getSmoothStepPath({ ...edge, borderRadius: BACKWARD_EDGE_RADIUS })[0]);
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
