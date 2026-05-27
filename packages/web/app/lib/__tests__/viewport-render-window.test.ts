import { describe, expect, it } from "vitest";
import { selectRenderWindow } from "../viewport-render-window";

describe("selectRenderWindow", () => {
  it("selects candidates intersecting the viewport plus overscan", () => {
    const selection = selectRenderWindow(
      [
        { id: "inside", x: 10, y: 10, width: 20, height: 20 },
        { id: "overscan", x: 130, y: 10, width: 20, height: 20 },
        { id: "outside", x: 240, y: 10, width: 20, height: 20 },
      ],
      {
        viewport: { x: 0, y: 0, zoom: 1 },
        size: { width: 100, height: 100 },
        maxItems: 10,
        overscanPx: 50,
      },
    );

    expect([...selection.ids].sort()).toEqual(["inside", "overscan"]);
  });

  it("keeps must-include ids even when they are outside the viewport", () => {
    const selection = selectRenderWindow(
      [
        { id: "inside", x: 10, y: 10, width: 20, height: 20 },
        { id: "focused", x: 10_000, y: 10_000, width: 20, height: 20 },
      ],
      {
        viewport: { x: 0, y: 0, zoom: 1 },
        size: { width: 100, height: 100 },
        maxItems: 1,
        mustIncludeIds: ["focused"],
      },
    );

    expect([...selection.ids]).toEqual(["focused"]);
  });

  it("uses visibility, priority, and distance to fill a capped window", () => {
    const selection = selectRenderWindow(
      [
        { id: "near-low-priority", x: 10, y: 10, width: 20, height: 20, priority: 20 },
        { id: "far-high-priority", x: 90, y: 90, width: 20, height: 20, priority: 1 },
        { id: "overscan-high-priority", x: 130, y: 10, width: 20, height: 20, priority: 0 },
      ],
      {
        viewport: { x: 0, y: 0, zoom: 1 },
        size: { width: 100, height: 100 },
        maxItems: 2,
        overscanPx: 50,
      },
    );

    expect([...selection.ids]).toEqual(["far-high-priority", "near-low-priority"]);
    expect(selection.capped).toBe(true);
  });
});
