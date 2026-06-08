import { describe, expect, it } from "vitest";

import {
  EDGE_LABEL_MAX_CH,
  processEdgeLabelData,
  processEdgeLabelStyles,
  processEdgeLabelText,
} from "../process-edge-label-style";

describe("processEdgeLabelStyles", () => {
  it("lets a long arrow tag wrap onto multiple lines instead of one wide ribbon", () => {
    const { labelStyle } = processEdgeLabelStyles("#e11d48");
    // A bounded width is what forces a long tag like
    // "Verify poster or contact user" to break across lines instead of
    // stretching into a ribbon that overlaps neighboring nodes...
    expect(labelStyle.maxWidth).toBe(`${EDGE_LABEL_MAX_CH}ch`);
    // ...and the text must be allowed to flow, not pinned to a single line.
    expect(labelStyle.whiteSpace).toBe("normal");
    expect(labelStyle.whiteSpace).not.toBe("nowrap");
  });

  it("centers the wrapped lines so a two-line tag stays symmetric", () => {
    const { labelStyle } = processEdgeLabelStyles("#000000");
    expect(labelStyle.textAlign).toBe("center");
  });

  it("puts the width cap on the monospace text span, where `ch` is exact", () => {
    // `ch` resolves against the element's own font; only the text span
    // carries the canvas monospace font, so the cap must live on labelStyle —
    // a `ch` cap on the box would measure against the wrong (inherited) font.
    const { labelBoxStyle, labelStyle } = processEdgeLabelStyles("#000000");
    expect(labelBoxStyle.maxWidth).toBeUndefined();
    expect(labelStyle.maxWidth).toBe(`${EDGE_LABEL_MAX_CH}ch`);
  });

  it("keeps the pill border tinted with the edge's stroke color", () => {
    const { labelBoxStyle } = processEdgeLabelStyles("#123456");
    expect(labelBoxStyle.border).toBe("1px solid #123456");
  });
});

describe("processEdgeLabelText", () => {
  it("shows the condition text when it exists", () => {
    expect(processEdgeLabelText("Yes", "flows_to")).toBe("Yes");
    expect(processEdgeLabelText("If approved", "flows_to")).toBe("If approved");
  });

  it("falls back to the edge type when no condition is set", () => {
    expect(processEdgeLabelText(null, "flows_to")).toBe("flows_to");
    expect(processEdgeLabelText(undefined, "flows_to")).toBe("flows_to");
    expect(processEdgeLabelText("", "flows_to")).toBe("flows_to");
  });

  it("trims whitespace from the condition before deciding", () => {
    expect(processEdgeLabelText("  ", "flows_to")).toBe("flows_to");
    expect(processEdgeLabelText("  Yes  ", "flows_to")).toBe("Yes");
  });
});

describe("processEdgeLabelData", () => {
  // This is the single payload every process arrow's `data` is built from —
  // sequence flow, cross-pool boundary, and parent hierarchy alike — so that a
  // tag is never accidentally omitted from one kind of arrow. Each assertion
  // here is what guarantees "every rendered arrow shows its type or condition".
  it("always produces a non-empty tag, falling back to the edge type", () => {
    // A plain flows_to with no condition still shows its type — never blank.
    expect(processEdgeLabelData(null, "flows_to", "#000000", 1).label).toBe("flows_to");
    expect(processEdgeLabelData(undefined, "has_parent", "#000000", 1).label).toBe("has_parent");
  });

  it("shows the condition when one is set, so a cross-pool flow reads like an in-pool one", () => {
    expect(processEdgeLabelData("Yes", "flows_to", "#000000", 1).label).toBe("Yes");
  });

  it("carries the pill styling tinted with the arrow's stroke color", () => {
    const { labelBoxStyle, labelStyle } = processEdgeLabelData("Yes", "flows_to", "#123456", 1);
    expect(labelBoxStyle.border).toBe("1px solid #123456");
    expect(labelStyle.maxWidth).toBe(`${EDGE_LABEL_MAX_CH}ch`);
  });

  it("threads the arrow's opacity through and rides above the edge", () => {
    const data = processEdgeLabelData("Yes", "flows_to", "#000000", 0.4);
    expect(data.labelOpacity).toBe(0.4);
    expect(data.labelZIndex).toBe(1);
  });
});
