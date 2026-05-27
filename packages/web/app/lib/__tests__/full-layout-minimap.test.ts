import { describe, expect, it } from "vitest";
import {
  computeFullLayoutMiniMapBase,
  computeFullLayoutMiniMapViewportRect,
  pointForMiniMapPosition,
} from "../full-layout-minimap";

describe("full-layout minimap geometry", () => {
  it("fits every item from the full layout into the panel", () => {
    const base = computeFullLayoutMiniMapBase(
      [
        { id: "near", x: 0, y: 0, width: 100, height: 50, color: "#000", kind: "node" },
        { id: "far", x: 2500, y: 1200, width: 120, height: 80, color: "#000", kind: "node" },
        {
          id: "lane",
          x: -40,
          y: 900,
          width: 2800,
          height: 180,
          color: "rgba(0,0,0,0.05)",
          kind: "lane",
        },
      ],
      { width: 140, height: 100, padding: 8 },
    );

    expect(base).not.toBeNull();
    expect(base?.rects.map((rect) => rect.id)).toEqual(["near", "far", "lane"]);
    for (const rect of base?.rects ?? []) {
      expect(rect.mapX).toBeGreaterThanOrEqual(0);
      expect(rect.mapY).toBeGreaterThanOrEqual(0);
      expect(rect.mapX + rect.mapWidth).toBeLessThanOrEqual(140);
      expect(rect.mapY + rect.mapHeight).toBeLessThanOrEqual(100);
    }
  });

  it("maps viewport rectangles and pointer positions back to canvas coordinates", () => {
    const base = computeFullLayoutMiniMapBase(
      [{ id: "node", x: 0, y: 0, width: 1000, height: 500, color: "#000", kind: "node" }],
      { width: 140, height: 100, padding: 8 },
    );
    expect(base).not.toBeNull();
    if (!base) return;

    const viewportRect = computeFullLayoutMiniMapViewportRect(
      base,
      { x: -500, y: -250, zoom: 1 },
      { width: 200, height: 100 },
    );
    const center = pointForMiniMapPosition(
      base,
      viewportRect.x + viewportRect.width / 2,
      viewportRect.y + viewportRect.height / 2,
    );

    expect(center.x).toBeCloseTo(600);
    expect(center.y).toBeCloseTo(300);
  });
});
