import { describe, expect, it } from "vitest";

import { effectivePerspectiveFocusId } from "../perspective-focus";

describe("effectivePerspectiveFocusId", () => {
  it("re-centers the perspective on a node opened from a dialog edge, overriding the route focus", () => {
    // The page booted on node_A's URL (route focus = node_A) and the user
    // clicked an edge row inside that dialog to open node_B client-side.
    // The canvas must follow node_B — exactly as if node_B's URL had been
    // opened from scratch — not stay parked on node_A.
    expect(effectivePerspectiveFocusId("node_B", "node_A")).toBe("node_B");
  });

  it("falls back to the route focus when nothing has been opened from a panel", () => {
    expect(effectivePerspectiveFocusId(null, "node_A")).toBe("node_A");
  });

  it("focuses nothing when neither a panel nor the route names a node", () => {
    expect(effectivePerspectiveFocusId(null, null)).toBeNull();
  });
});
