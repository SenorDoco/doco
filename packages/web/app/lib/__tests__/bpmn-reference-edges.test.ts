import { describe, expect, it } from "vitest";
import { referenceEdges } from "../bpmn-reference-edges";

const set = (...ids: string[]) => new Set(ids);

describe("referenceEdges", () => {
  it("draws a link for an association edge whose target is a Reference", () => {
    const edges = referenceEdges(
      [{ source: "decision_1", target: "reference_1" }],
      set("reference_1"),
      set("decision_1", "reference_1"),
    );
    expect(edges).toEqual([
      { id: "reference:decision_1|reference_1", source: "decision_1", target: "reference_1" },
    ]);
  });

  it("draws a link when the Reference is the edge source, preserving direction", () => {
    const edges = referenceEdges(
      [{ source: "reference_1", target: "action_1" }],
      set("reference_1"),
      set("reference_1", "action_1"),
    );
    expect(edges).toEqual([
      { id: "reference:action_1|reference_1", source: "reference_1", target: "action_1" },
    ]);
  });

  it("ignores edges with no Reference endpoint (sequence flow stays untouched)", () => {
    const edges = referenceEdges(
      [{ source: "action_1", target: "decision_1" }],
      set("reference_1"),
      set("action_1", "decision_1", "reference_1"),
    );
    expect(edges).toEqual([]);
  });

  it("drops reference links whose other endpoint is off-canvas (no dangling)", () => {
    const edges = referenceEdges(
      [{ source: "decision_1", target: "reference_1" }],
      set("reference_1"),
      set("reference_1"), // decision_1 not rendered
    );
    expect(edges).toEqual([]);
  });

  it("collapses parallel and reversed edges between the same pair to one line", () => {
    const edges = referenceEdges(
      [
        { source: "decision_1", target: "reference_1" },
        { source: "reference_1", target: "decision_1" },
        { source: "decision_1", target: "reference_1" },
      ],
      set("reference_1"),
      set("decision_1", "reference_1"),
    );
    expect(edges).toHaveLength(1);
  });

  it("includes reference-to-reference associations", () => {
    const edges = referenceEdges(
      [{ source: "reference_1", target: "reference_2" }],
      set("reference_1", "reference_2"),
      set("reference_1", "reference_2"),
    );
    expect(edges).toHaveLength(1);
  });
});
