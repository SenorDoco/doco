import { describe, expect, it } from "vitest";
import { layOutProcess } from "~/components/perspectives/process-perspective";
import type { ProcessLane, ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

// One pool with two actor lanes. Only the first owns a node; the second
// models a principal whose work was all filtered out — e.g. a retired
// principal in the overview pool once "Retired" is hidden. An emptied lane
// must reserve no vertical space, not render as a blank band.
const pools: ProcessPool[] = [
  { id: "pool:i1", process_id: "i1", label: "Hire", lifecycle: "active" },
];
const lanes: ProcessLane[] = [
  {
    id: "pool:i1::principal_a",
    pool_id: "pool:i1",
    base_id: "principal_a",
    label: "Recruiter",
    kind: "actor",
    lifecycle: "active",
  },
  {
    id: "pool:i1::principal_b",
    pool_id: "pool:i1",
    base_id: "principal_b",
    label: "Retired person",
    kind: "actor",
    lifecycle: "retired",
  },
];
const populated: ProcessNode = {
  id: "a1",
  node_type: "action",
  name: "a1",
  lifecycle: "active",
  created_at: null,
  href: null,
  shape: "task",
  laneId: "pool:i1::principal_a",
  pool_id: "pool:i1",
};

describe("layOutProcess empty lanes", () => {
  it("drops a lane with no nodes — no geometry, no chrome, no reserved band", () => {
    const layout = layOutProcess(pools, lanes, [populated], [], "a1", new Set(), null, false);

    // The empty lane is gone from the per-lane geometry…
    expect(layout.lanes.map((lane) => lane.id)).toEqual(["pool:i1::principal_a"]);
    // …and from the flow nodes (no swim-lane chrome node was emitted for it).
    expect(layout.flowNodes.some((fn) => fn.id === "lane:pool:i1::principal_b")).toBe(false);

    // The pool ends exactly at the bottom of its only populated lane — no
    // empty band tacked on below to leave the screenshot's blank gap.
    const laneA = layout.lanes.find((lane) => lane.id === "pool:i1::principal_a");
    const pool = layout.poolGeometry.find((p) => p.id === "pool:i1");
    if (!laneA || !pool) throw new Error("expected lane and pool geometry");
    expect(pool.y + pool.height).toBe(laneA.y + laneA.height);
  });

  it("keeps a lane that still owns a node", () => {
    const layout = layOutProcess(pools, lanes, [populated], [], "a1", new Set(), null, false);
    expect(layout.lanes.some((lane) => lane.id === "pool:i1::principal_a")).toBe(true);
    expect(layout.flowNodes.some((fn) => fn.id === "lane:pool:i1::principal_a")).toBe(true);
  });
});
