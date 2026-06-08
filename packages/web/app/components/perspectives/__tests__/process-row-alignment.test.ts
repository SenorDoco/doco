import { describe, expect, it } from "vitest";
import { layOutProcess } from "~/components/perspectives/process-perspective";
import type { ProcessLane, ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

// One actor lane. Two roots (a1, a2) stack in column 0; `b` follows only a1.
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
];
const node = (id: string, created_at: string | null): ProcessNode => ({
  id,
  entity_type: "action",
  name: id,
  lifecycle: "active",
  created_at,
  href: null,
  shape: "task",
  laneId: "pool:i1::principal_a",
  pool_id: "pool:i1",
});

function center(layout: ReturnType<typeof layOutProcess>, id: string): number {
  const fn = layout.flowNodes.find((n) => n.id === id);
  if (!fn) throw new Error(`node ${id} not laid out`);
  return fn.position.y + Number(fn.style?.height ?? 0) / 2;
}

describe("layOutProcess vertical alignment", () => {
  it("draws a single-predecessor node on its predecessor's line, not re-centered", () => {
    const nodes = [
      node("a1", "2026-05-26T00:00:00.000Z"),
      node("a2", "2026-05-26T00:01:00.000Z"),
      node("b", "2026-05-26T00:02:00.000Z"),
    ];
    const links = [{ source: "a1", target: "b", edge_type: "flows_to" }];
    const layout = layOutProcess(pools, lanes, nodes, links, "a1", new Set(), null, false);

    // a1 stacks above a2 in column 0; b follows only a1, so it rides a1's line.
    expect(center(layout, "a1")).toBeLessThan(center(layout, "a2"));
    expect(center(layout, "b")).toBe(center(layout, "a1"));
    // Centering on its own (single-node) column would have parked b at the
    // lane's middle — halfway between a1 and a2 — which it must NOT do.
    const laneMiddle = (center(layout, "a1") + center(layout, "a2")) / 2;
    expect(center(layout, "b")).not.toBe(laneMiddle);
  });

  it("centers a node that merges two predecessors instead of aligning", () => {
    const nodes = [
      node("a1", "2026-05-26T00:00:00.000Z"),
      node("a2", "2026-05-26T00:01:00.000Z"),
      node("m", "2026-05-26T00:02:00.000Z"),
    ];
    // m has two forward predecessors — it has no single line to follow.
    const links = [
      { source: "a1", target: "m", edge_type: "flows_to" },
      { source: "a2", target: "m", edge_type: "flows_to" },
    ];
    const layout = layOutProcess(pools, lanes, nodes, links, "a1", new Set(), null, false);
    const laneMiddle = (center(layout, "a1") + center(layout, "a2")) / 2;
    expect(center(layout, "m")).toBe(laneMiddle);
  });

  it("orders a branching column by the flow so parallel chains don't cross", () => {
    // top→y and bottom→x, but x is created before y. Creation order alone
    // would stack x above y (against the flow) and the overlap solver would
    // pool both to the lane center, undoing the alignment. The flow-aware
    // ordering instead keeps y on top's line and x on bottom's.
    const nodes = [
      node("top", "2026-05-26T00:00:00.000Z"),
      node("bottom", "2026-05-26T00:01:00.000Z"),
      node("x", "2026-05-26T00:02:00.000Z"),
      node("y", "2026-05-26T00:03:00.000Z"),
    ];
    const links = [
      { source: "top", target: "y", edge_type: "flows_to" },
      { source: "bottom", target: "x", edge_type: "flows_to" },
    ];
    const layout = layOutProcess(pools, lanes, nodes, links, "top", new Set(), null, false);

    expect(center(layout, "top")).toBeLessThan(center(layout, "bottom"));
    expect(center(layout, "y")).toBe(center(layout, "top"));
    expect(center(layout, "x")).toBe(center(layout, "bottom"));
    // y rides the top line, x the bottom — the chains stay parallel, uncrossed.
    expect(center(layout, "y")).toBeLessThan(center(layout, "x"));
  });
});
