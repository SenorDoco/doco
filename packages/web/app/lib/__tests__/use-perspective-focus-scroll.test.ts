import { describe, expect, it } from "vitest";

import { shouldFocusPerspectiveNode } from "../use-perspective-focus-scroll";

describe("shouldFocusPerspectiveNode", () => {
  it("focuses a node just opened from a dialog edge", () => {
    expect(shouldFocusPerspectiveNode("node_B", "node_A")).toBe(true);
  });

  it("focuses the first node when nothing has been focused yet", () => {
    expect(shouldFocusPerspectiveNode("node_A", null)).toBe(true);
  });

  it("does not re-focus the node already in view, so re-renders don't yank the scroll", () => {
    expect(shouldFocusPerspectiveNode("node_A", "node_A")).toBe(false);
  });

  it("does nothing when there is no focus target", () => {
    expect(shouldFocusPerspectiveNode(null, "node_A")).toBe(false);
    expect(shouldFocusPerspectiveNode(undefined, null)).toBe(false);
  });
});
