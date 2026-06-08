import { describe, expect, it } from "vitest";
import {
  laneRailGeometry,
  railLabelsVisible,
  stickyPoolPinned,
} from "~/lib/process-sticky-overlays";

// Canvas-space geometry × the live React Flow viewport (pan + zoom) decides
// where the BPMN sticky overlays sit. These are the per-frame decisions that
// used to live inline in the perspective body; pinning them here lets a small
// store-subscribed child own the pan re-render instead of the whole perspective.

const VIEW = (x: number, y: number, zoom: number) => ({ x, y, zoom });
const CANVAS_H = 480;

describe("laneRailGeometry", () => {
  it("returns null for a lane fully above the canvas top", () => {
    // lane at canvas y=0..140, panned up by 200px → bottom at -60 (off-screen)
    expect(laneRailGeometry(0, 140, VIEW(0, -200, 1), CANVAS_H)).toBeNull();
  });

  it("returns null for a lane fully below the canvas bottom", () => {
    expect(laneRailGeometry(600, 140, VIEW(0, 0, 1), CANVAS_H)).toBeNull();
  });

  it("pins a fully-visible lane at its screen top with its scaled height", () => {
    const g = laneRailGeometry(100, 140, VIEW(0, 0, 1), CANVAS_H);
    expect(g).toEqual({ top: 100, height: 140 });
  });

  it("clamps the rail to the canvas top when the lane straddles it", () => {
    // lane y=0..140 panned up 40px → screen 40..(wait) ; use top above 0
    const g = laneRailGeometry(0, 140, VIEW(0, -40, 1), CANVAS_H);
    // visibleTop clamps to 0; height is the on-screen slice (140-40=100)
    expect(g).toEqual({ top: 0, height: 100 });
  });

  it("never shrinks the rail below the minimum and keeps it on-screen", () => {
    // a 10px sliver visible at the very bottom of the canvas → height floored
    // to 44, top clamped up so the 44px rail stays within the canvas.
    const g = laneRailGeometry(0, 478, VIEW(0, 470, 1), CANVAS_H);
    expect(g).not.toBeNull();
    expect(g?.height).toBe(44);
    expect(g?.top).toBe(CANVAS_H - 44);
  });

  it("pins a top sliver to the canvas top", () => {
    // the symmetric case: only the bottom edge of a tall lane shows, at the
    // top of the screen → rail sits at top 0, floored to the min height.
    const g = laneRailGeometry(0, 480, VIEW(0, -470, 1), CANVAS_H);
    expect(g).toEqual({ top: 0, height: 44 });
  });

  it("scales lane height by zoom", () => {
    const g = laneRailGeometry(0, 140, VIEW(0, 0, 0.5), CANVAS_H);
    expect(g).toEqual({ top: 0, height: 70 });
  });
});

describe("railLabelsVisible", () => {
  const OFFSET = 156; // LANE_LEFT_INSET (16) + LANE_LABEL_WIDTH (140)
  const RAIL_W = 32;

  it("is false when the canvas is simplified (LOD drops labels)", () => {
    expect(railLabelsVisible(VIEW(0, 0, 1), OFFSET, RAIL_W, true)).toBe(false);
  });

  it("is false while the in-canvas label is still on screen", () => {
    // not panned: in-canvas label right edge at 156 > rail width 32 → show
    // the in-canvas label, not the rail label.
    expect(railLabelsVisible(VIEW(0, 0, 1), OFFSET, RAIL_W, false)).toBe(false);
  });

  it("is true once the in-canvas label has panned left past the rail", () => {
    // pan left by 200px → label right edge at 156-200 = -44 ≤ 32 → rail owns it
    expect(railLabelsVisible(VIEW(-200, 0, 1), OFFSET, RAIL_W, false)).toBe(true);
  });
});

describe("stickyPoolPinned", () => {
  const RAIL_H = 32;

  it("is false while the pool's own header is still visible", () => {
    // pool top on screen (>=0) → no need to pin a copy
    expect(stickyPoolPinned(50, 400, VIEW(0, 0, 1), CANVAS_H, RAIL_H)).toBe(false);
  });

  it("pins when the header scrolled above the top but the body is on screen", () => {
    // pool y=0..400 panned up 100 → top at -100 (above), bottom at 300 (visible)
    expect(stickyPoolPinned(0, 400, VIEW(0, -100, 1), CANVAS_H, RAIL_H)).toBe(true);
  });

  it("is false once the whole pool has scrolled off the bottom", () => {
    expect(stickyPoolPinned(600, 400, VIEW(0, 0, 1), CANVAS_H, RAIL_H)).toBe(false);
  });

  it("is false once the pool has scrolled off the top", () => {
    // bottom at rail height or less → nothing left to label
    expect(stickyPoolPinned(0, 400, VIEW(0, -400, 1), CANVAS_H, RAIL_H)).toBe(false);
  });
});
