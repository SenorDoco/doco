import { describe, expect, it } from "vitest";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { computeProcessRenderedSet } from "~/components/perspectives/process-perspective";
import type { ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

// Two processes (pools), each with two sequenced members, joined by a single
// cross-process hand-off edge (a2 → b1).
const pools: ProcessPool[] = [
  { id: "pool:p1", process_id: "p1", label: "Hire", lifecycle: "active" },
  { id: "pool:p2", process_id: "p2", label: "Onboard", lifecycle: "active" },
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
  node("a1", "pool:p1"),
  node("a2", "pool:p1"),
  node("b1", "pool:p2"),
  node("b2", "pool:p2"),
];
const links: OverviewGraphLink[] = [
  { id: "e:a1-a2", source: "a1", target: "a2", edge_type: "flows_to" },
  { id: "e:a2-b1", source: "a2", target: "b1", edge_type: "flows_to" },
  { id: "e:b1-b2", source: "b1", target: "b2", edge_type: "flows_to" },
];

describe("computeProcessRenderedSet", () => {
  it("renders the focal node's whole process — cross-process neighbours are outside boxes, not members", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a2",
      focusedEdgeId: null,
      focusedNodeIds: new Set(),
    });
    expect([...focalPoolIds]).toEqual(["pool:p1"]);
    // Only the focal process's members render; b1 (another process) does not —
    // it surfaces as an exit box drawn outside the pool by the renderer.
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2"]));
  });

  it("an expanded subprocess frames its OWN pool, overriding the member's parent", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a2", // a member of pool:p1…
      expandedProcessId: "p2", // …but p2 is expanded, so its pool frames.
      focusedEdgeId: null,
      focusedNodeIds: new Set(),
    });
    expect([...focalPoolIds]).toEqual(["pool:p2"]);
    expect(renderedNodeIds).toEqual(new Set(["b1", "b2"]));
  });

  it("renders only the one process for an edge whose endpoints share it", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a1",
      focusedEdgeId: "e:a1-a2",
      focusedNodeIds: new Set(["a1", "a2"]),
    });
    expect([...focalPoolIds]).toEqual(["pool:p1"]);
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2"]));
  });

  it("renders BOTH processes in full for an edge spanning two of them", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a2",
      focusedEdgeId: "e:a2-b1",
      focusedNodeIds: new Set(["a2", "b1"]),
    });
    expect([...focalPoolIds].sort()).toEqual(["pool:p1", "pool:p2"]);
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2", "b1", "b2"]));
  });

  it("resolves an edge endpoint that is itself a process Action to its pool", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "a2",
      focusedEdgeId: "e:a2-parent-p2",
      focusedNodeIds: new Set(["a2", "p2"]),
    });
    expect([...focalPoolIds].sort()).toEqual(["pool:p1", "pool:p2"]);
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2", "b1", "b2"]));
  });

  it("renders nothing focal when there is no center and no default pool", () => {
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

  it("frames the default pool (the overview's synthetic pool) when nothing else is focal", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: null,
      focusedEdgeId: null,
      focusedNodeIds: new Set(),
      defaultPoolId: "pool:p1",
    });
    expect([...focalPoolIds]).toEqual(["pool:p1"]);
    expect(renderedNodeIds).toEqual(new Set(["a1", "a2"]));
  });

  it("an explicit focus wins over the default pool", () => {
    const { focalPoolIds, renderedNodeIds } = computeProcessRenderedSet({
      nodes,
      pools,
      links,
      centerId: "b1",
      focusedEdgeId: null,
      focusedNodeIds: new Set(),
      defaultPoolId: "pool:p1",
    });
    expect([...focalPoolIds]).toEqual(["pool:p2"]);
    expect(renderedNodeIds).toEqual(new Set(["b1", "b2"]));
  });
});
