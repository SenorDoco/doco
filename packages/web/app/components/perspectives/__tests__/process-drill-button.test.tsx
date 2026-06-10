import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProcessNode } from "~/lib/process-perspective.server";
import { NodeDrillButton } from "../process-perspective";

// The drill pill is a plain button, but importing the module pulls in
// `@xyflow/react`; mock it so no ReactFlow provider is needed for the SSR render
// (matching the sibling shape-render tests).
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useStore: () => false,
}));

const node: ProcessNode = {
  id: "n1",
  node_type: "action",
  name: "Post a job",
  lifecycle: "active",
  created_at: null,
  href: "/doco/action/n1",
  shape: "task",
  laneId: "lane_1",
  pool_id: "pool:p1",
};

describe("NodeDrillButton", () => {
  it("renders the drill label as a real button", () => {
    const html = renderToStaticMarkup(
      createElement(NodeDrillButton, {
        drill: { label: "View in own process", onClick: () => {} },
        node,
        stroke: "#000",
      }),
    );
    expect(html).toContain("<button");
    expect(html).toContain("View in own process");
  });

  it("shows the glyph (aria-hidden) only when one is given", () => {
    const withGlyph = renderToStaticMarkup(
      createElement(NodeDrillButton, {
        drill: { label: "View subprocess", glyph: "⊞", onClick: () => {} },
        node,
        stroke: "#000",
      }),
    );
    expect(withGlyph).toContain("⊞");
    expect(withGlyph).toContain("aria-hidden");

    const noGlyph = renderToStaticMarkup(
      createElement(NodeDrillButton, {
        drill: { label: "View process", onClick: () => {} },
        node,
        stroke: "#000",
      }),
    );
    expect(noGlyph).not.toContain("aria-hidden");
  });

  it("renders nothing when hidden (the zoomed-out LOD state)", () => {
    const html = renderToStaticMarkup(
      createElement(NodeDrillButton, {
        drill: { label: "View process", onClick: () => {} },
        node,
        stroke: "#000",
        hidden: true,
      }),
    );
    expect(html).toBe("");
  });
});
