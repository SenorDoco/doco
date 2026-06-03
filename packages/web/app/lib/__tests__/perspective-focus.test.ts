import { describe, expect, it } from "vitest";

import { effectivePerspectiveFocusId, perspectiveCenterId } from "../perspective-focus";

describe("perspectiveCenterId", () => {
  it("centers on the focused node even when the detail is suppressed by ?dialog=skip", () => {
    // Señor Doco's auto-focus navigates with ?dialog=skip — the loader
    // nulls the dialog detail (selectedNode) to keep the overlay off the
    // chat, but still reports the node via focusedNodeId. The perspective
    // must follow that focus and re-center on the node; deriving the
    // center from the dialog-gated detail (the old bug) parks it on the
    // previous node instead.
    expect(perspectiveCenterId({ focusedNodeId: "decision_B", focusedEdgeFromId: null })).toBe(
      "decision_B",
    );
  });

  it("centers an edge focus on the edge's source node", () => {
    // Edges are focusable too; centering on one means centering on its
    // source node, which the loader resolves as focusedEdgeFromId.
    expect(perspectiveCenterId({ focusedNodeId: null, focusedEdgeFromId: "decision_A" })).toBe(
      "decision_A",
    );
  });

  it("prefers an explicit node focus over an edge source", () => {
    expect(
      perspectiveCenterId({ focusedNodeId: "decision_B", focusedEdgeFromId: "decision_A" }),
    ).toBe("decision_B");
  });

  it("centers on nothing when neither a node nor an edge is focused", () => {
    expect(perspectiveCenterId({ focusedNodeId: null, focusedEdgeFromId: null })).toBeNull();
  });
});

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
