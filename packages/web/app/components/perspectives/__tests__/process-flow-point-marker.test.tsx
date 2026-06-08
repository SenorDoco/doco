import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProcessNode } from "~/lib/process-perspective.server";
import { ProcessRectangleNode } from "../process-perspective";

// Render at reading zoom (1) so the shape draws its full chrome — including
// the badge row, which now carries the entry/exit flow-point tag.
// `useProcessSimplified` reads zoom via `useStore`; feed a non-simplified one.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

function node(lifecycle: string, flags: Partial<ProcessNode>): ProcessNode {
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
    ...flags,
  };
}

function render(lifecycle: string, flags: Partial<ProcessNode>): string {
  return renderToStaticMarkup(
    createElement(ProcessRectangleNode, {
      data: { node: node(lifecycle, flags), isCenter: false },
    }),
  );
}

describe("process entry/exit flow-point tag", () => {
  it("renders the Entry tag vertically on the left, reading bottom-to-top", () => {
    const html = render("drafting", { entry_point: true });
    expect(html).toContain("Entry");
    expect(html).toContain("rotate(-90deg)"); // stood up, reading bottom-to-top
    expect(html).toContain("left:0");
  });

  it("renders the Exit tag vertically on the right, reading top-to-bottom", () => {
    const html = render("active", { exit_point: true });
    expect(html).toContain("Exit");
    expect(html).toContain("rotate(90deg)"); // stood up, reading top-to-bottom
    expect(html).toContain("right:0");
  });

  it("keeps the BPMN event ring on the tag", () => {
    expect(render("drafting", { entry_point: true })).toContain("border-radius:50%");
  });

  it("styles the tag like the lifecycle/type badges — a lifecycle-colored pill", () => {
    // Same pill treatment as NodeBadgeRow: the lifecycle color is the
    // background (not low-contrast text). A queued node's tag is blue, like
    // its other badges.
    const html = render("queued", { entry_point: true });
    expect(html).toContain("rotate(-90deg)");
    expect(html).toContain("background:#2563eb");
  });

  it("renders no flow-point tag when the node is neither entry nor exit", () => {
    const html = render("active", {});
    expect(html).not.toContain("rotate(-90deg)");
    expect(html).not.toContain("rotate(90deg)");
  });
});
