import { describe, expect, it } from "vitest";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { computeProcessRenderedSet } from "~/components/perspectives/process-perspective";
import type { ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

// Two intents (pools), each with two sequenced Actions, joined by a single
// cross-intent hand-off edge (a2 → b1).
const pools: ProcessPool[] = [
  { id: "pool:i1", intent_id: "i1", label: "Hire", lifecycle: "active" },
  { id: "pool:i2", intent_id: "i2", label: "Onboard", lifecycle: "active" },
];
const node = (id: string, poolId: string): ProcessNode => ({
  id,
  entity_type: "action",
  name: id,
  lifecycle: "active",
  created_at: null,
  href: null,
  shape: "task",
  laneId: `${poolId}::principal_a`,
  pool_id: poolId,
});
const nodes = [
  node("a1", "pool:i1"),
  node("a2", "pool:i1"),
  node("b1", "pool:i2"),
  node("b2", "pool:i2"),
];
const links: OverviewGraphLink[] = [
  { id: "e:a1-a2", source: "a1", target: "a2", edge_type: "flows_to" },
  { id: "e:a2-b1", source: "a2", target: "b1", edge_type: "flows_to" },
  { id: "e:b1-b2", source: "b1", target: "b2", edge_type: "flows_to" },
];

describe("computeProcessRenderedSet", () => {
  it("renders the focal node's whole intent plus first-degree cross-intent neighbours", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a2",
      focusedEdgeId: null,
      focusedNodeIds: new Set(),
    });
    expect([...focalPoolIds]).toEqual(["pool:i1"]);
    // a1, a2 from the intent; b1 pulled in as a1-degree neighbour; not b2.
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2", "b1"]));
  });

  it("renders only the one intent for an edge whose endpoints share an intent", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a1",
      focusedEdgeId: "e:a1-a2",
      focusedNodeIds: new Set(["a1", "a2"]),
    });
    expect([...focalPoolIds]).toEqual(["pool:i1"]);
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2"]));
  });

  it("renders BOTH intents in full for an edge spanning two intents", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      // The focal node is the edge's source (a2), but the edge crosses into i2.
      centerId: "a2",
      focusedEdgeId: "e:a2-b1",
      focusedNodeIds: new Set(["a2", "b1"]),
    });
    expect([...focalPoolIds].sort()).toEqual(["pool:i1", "pool:i2"]);
    // Every node of both intents — including b2, which is not a neighbour of
    // the focal node — must render.
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2", "b1", "b2"]));
  });

  it("resolves an edge endpoint that is itself an Intent to its pool", () => {
    // A `serves` edge from action a2 into intent i2 (the pool, not a node).
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a2",
      focusedEdgeId: "e:a2-serves-i2",
      focusedNodeIds: new Set(["a2", "i2"]),
    });
    expect([...focalPoolIds].sort()).toEqual(["pool:i1", "pool:i2"]);
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2", "b1", "b2"]));
  });

  it("renders nothing focal when there is no center", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: null,
      focusedEdgeId: null,
      focusedNodeIds: new Set(),
    });
    expect(focalPoolIds.size).toBe(0);
    expect(renderedNodeIds.size).toBe(0);
  });
});
