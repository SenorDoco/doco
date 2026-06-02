import { describe, expect, it } from "vitest";
import { referenceAnchorColumns, referenceEdges } from "../bpmn-references";

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

describe("referenceAnchorColumns", () => {
  const nodes = [
    { id: "action_1", entity_type: "action" },
    { id: "action_2", entity_type: "action" },
    { id: "reference_1", entity_type: "reference" },
    { id: "reference_2", entity_type: "reference" },
  ];

  it("places a reference in the column of the step it cites", () => {
    const cols = referenceAnchorColumns(
      nodes,
      [{ source: "action_1", target: "reference_1" }],
      new Map([["action_1", 3]]),
    );
    expect(cols.get("reference_1")).toBe(3);
  });

  it("anchors regardless of edge direction", () => {
    const cols = referenceAnchorColumns(
      nodes,
      [{ source: "reference_1", target: "action_1" }],
      new Map([["action_1", 2]]),
    );
    expect(cols.get("reference_1")).toBe(2);
  });

  it("anchors a depth-0 step rather than omitting it", () => {
    const cols = referenceAnchorColumns(
      nodes,
      [{ source: "action_1", target: "reference_1" }],
      new Map([["action_1", 0]]),
    );
    expect(cols.get("reference_1")).toBe(0);
  });

  it("defaults a missing depth entry to column 0 for a real step", () => {
    const cols = referenceAnchorColumns(
      nodes,
      [{ source: "action_1", target: "reference_1" }],
      new Map(), // action_1 absent from the depth map
    );
    expect(cols.get("reference_1")).toBe(0);
  });

  it("picks the shallowest (leftmost) anchor when several steps cite it", () => {
    const cols = referenceAnchorColumns(
      nodes,
      [
        { source: "reference_1", target: "action_1" },
        { source: "action_2", target: "reference_1" },
      ],
      new Map([
        ["action_1", 5],
        ["action_2", 2],
      ]),
    );
    expect(cols.get("reference_1")).toBe(2);
  });

  it("ignores reference-to-reference links (no real anchor)", () => {
    const cols = referenceAnchorColumns(
      nodes,
      [{ source: "reference_1", target: "reference_2" }],
      new Map([["action_1", 4]]),
    );
    expect(cols.has("reference_1")).toBe(false);
    expect(cols.has("reference_2")).toBe(false);
  });

  it("never keys non-reference nodes", () => {
    const cols = referenceAnchorColumns(
      nodes,
      [{ source: "action_1", target: "action_2" }],
      new Map([
        ["action_1", 1],
        ["action_2", 2],
      ]),
    );
    expect(cols.size).toBe(0);
  });
});
