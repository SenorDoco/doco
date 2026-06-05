import { describe, expect, it } from "vitest";
import { CLICKABLE_EDGE_CLASS, clickableEdgeClassName } from "../stable-labeled-edge";

// React Flow only paints the pointer cursor for `.selectable` edges (whose
// selection behavior we don't want), and an inline `cursor` on the edge
// `style` lands on the visible stroke — never the wider transparent
// `.react-flow__edge-interaction` path that actually catches the hover. So a
// clickable edge model carries this marker class and app.css sets the cursor
// on the edge group, which inherits down to the interaction path.
describe("clickableEdgeClassName", () => {
  it("marks a clickable edge", () => {
    expect(clickableEdgeClassName(true)).toBe(CLICKABLE_EDGE_CLASS);
  });

  it("appends the marker to a base class so existing edge styling survives", () => {
    expect(clickableEdgeClassName(true, "doco-graph-fade-edge")).toBe(
      `doco-graph-fade-edge ${CLICKABLE_EDGE_CLASS}`,
    );
  });

  it("leaves a non-clickable edge unmarked (no pointer cursor)", () => {
    expect(clickableEdgeClassName(false)).toBeUndefined();
    expect(clickableEdgeClassName(false, "doco-graph-fade-edge")).toBe("doco-graph-fade-edge");
  });
});
