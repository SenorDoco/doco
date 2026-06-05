import { describe, expect, it } from "vitest";

import {
  EDGE_LABEL_MAX_CH,
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
