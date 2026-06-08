import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProcessNode } from "~/lib/process-perspective.server";
import { FLOW_POINT_MARKER_COLOR, ProcessRectangleNode } from "../process-perspective";

// Render at reading zoom (1) so the shape draws its full chrome — badges,
// label, and the entry/exit flow-point marker. `useProcessSimplified`
// reads zoom via `useStore`; feed it a non-simplified transform.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

function entryNode(lifecycle: string): ProcessNode {
  return {
    id: "node_1",
    entity_type: "action",
    name: "Professional visits Torre.ai",
    lifecycle,
    created_at: null,
    href: "/doco/action/node_1",
    shape: "rectangle",
    laneId: "lane_1",
    pool_id: "pool_1",
    entry_point: true,
  };
}

function render(lifecycle: string): string {
  return renderToStaticMarkup(
    createElement(ProcessRectangleNode, { data: { node: entryNode(lifecycle), isCenter: false } }),
  );
}

describe("process entry/exit flow-point marker", () => {
  it("renders the Entry tag for an entry-point node", () => {
    expect(render("drafting")).toContain("Entry");
  });

  it("paints the marker a fixed neutral color, never the lifecycle stroke", () => {
    // A drafting node's stroke is yellow (#eab308); inheriting it washed the
    // tag out on the white card. The marker now uses a neutral slate so it
    // stays legible — and that slate is what shows up in the rendered style.
    expect(render("drafting")).toContain(FLOW_POINT_MARKER_COLOR);
  });

  it("uses the same neutral marker color regardless of lifecycle", () => {
    // Lifecycle independence: a queued (blue) node's marker is the same
    // neutral slate as a drafting (yellow) node's — color no longer leaks
    // the lifecycle stroke into the tag.
    expect(render("queued")).toContain(FLOW_POINT_MARKER_COLOR);
  });
});
