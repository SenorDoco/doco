import { describe, expect, it } from "vitest";
import { computeIntentEntryPointIds } from "../bpmn-entry-points";

describe("computeIntentEntryPointIds", () => {
  it("treats genuine sources (no incoming sequence flow) as entry points", () => {
    const nodes = [
      { id: "start", pool_id: "pool:a" },
      { id: "next", pool_id: "pool:a" },
    ];
    const links = [{ source: "start", target: "next", edge_type: "flows_to" }];

    const entry = computeIntentEntryPointIds(nodes, links);
    expect(entry.has("start")).toBe(true);
    expect(entry.has("next")).toBe(false);
  });

  it("treats nodes whose inflow comes only from another pool as entry points", () => {
    const nodes = [
      { id: "upstream", pool_id: "pool:a" },
      { id: "gateway", pool_id: "pool:b" },
      { id: "internal", pool_id: "pool:b" },
    ];
    const links = [
      // cross-pool hand-off into pool:b — `gateway` is where flow enters the intent
      { source: "upstream", target: "gateway", edge_type: "flows_to" },
      // same-pool continuation — `internal` is not an entry point
      { source: "gateway", target: "internal", edge_type: "flows_to" },
    ];

    const entry = computeIntentEntryPointIds(nodes, links);
    expect(entry.has("gateway")).toBe(true);
    expect(entry.has("internal")).toBe(false);
  });

  it("does not treat a node with any same-pool inflow as an entry point", () => {
    const nodes = [
      { id: "a", pool_id: "pool:x" },
      { id: "b", pool_id: "pool:x" },
      { id: "cross", pool_id: "pool:y" },
    ];
    const links = [
      // `b` has both a cross-pool inflow AND a same-pool inflow → not an entry point
      { source: "cross", target: "b", edge_type: "flows_to" },
      { source: "a", target: "b", edge_type: "flows_to" },
    ];

    const entry = computeIntentEntryPointIds(nodes, links);
    expect(entry.has("b")).toBe(false);
    // `a` has no inflow at all → entry point
    expect(entry.has("a")).toBe(true);
  });

  it("ignores non-sequence edges when deciding entry points", () => {
    const nodes = [
      { id: "owner", pool_id: "pool:a" },
      { id: "step", pool_id: "pool:a" },
    ];
    const links = [
      // a non-flows_to relation inside the pool must not disqualify `step`
      { source: "owner", target: "step", edge_type: "serves" },
    ];

    const entry = computeIntentEntryPointIds(nodes, links);
    expect(entry.has("step")).toBe(true);
  });

  it("ignores sequence edges from nodes outside the rendered node set", () => {
    const nodes = [{ id: "step", pool_id: "pool:a" }];
    const links = [
      // source was filtered out of the node set; it can't anchor `step` as
      // a same-pool continuation, so `step` is still an entry point.
      { source: "filtered-out", target: "step", edge_type: "flows_to" },
    ];

    const entry = computeIntentEntryPointIds(nodes, links);
    expect(entry.has("step")).toBe(true);
  });
});
