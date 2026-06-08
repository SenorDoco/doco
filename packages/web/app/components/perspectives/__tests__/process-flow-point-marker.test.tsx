import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProcessNode } from "~/lib/process-perspective.server";
import { FLOW_POINT_MARKER_COLOR, ProcessRectangleNode } from "../process-perspective";

// Render at reading zoom (1) so the shape draws its full chrome — badges
// and the label (which now carries the entry/exit indicator). `useProcessSimplified`
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

describe("process entry/exit flow-point indicator", () => {
  it("renders the Entry indicator in the node label", () => {
    expect(render("drafting")).toContain("Entry");
  });

  it("rides in the label's text flow, not a floating ring marker", () => {
    // The old design floated a ringed badge over the card's bottom edge,
    // where the type/lifecycle pills overlapped it. The indicator now sits on
    // its own line inside the label — so no ring glyph (a bordered circle in
    // the indicator's color) is drawn.
    expect(render("drafting")).not.toContain(`solid ${FLOW_POINT_MARKER_COLOR}`);
  });

  it("paints the indicator a fixed neutral color, never the lifecycle stroke", () => {
    // A drafting node's stroke is yellow (#eab308); inheriting it washed the
    // text out. The indicator uses a neutral slate so it stays legible.
    expect(render("drafting")).toContain(`color:${FLOW_POINT_MARKER_COLOR}`);
  });

  it("uses the same neutral color regardless of lifecycle", () => {
    expect(render("queued")).toContain(`color:${FLOW_POINT_MARKER_COLOR}`);
  });
});
