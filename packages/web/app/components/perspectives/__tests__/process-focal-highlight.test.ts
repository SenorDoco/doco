import { describe, expect, it } from "vitest";
import { layOutProcess } from "~/components/perspectives/process-perspective";
import type { ProcessLane, ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

// A minimal single-pool process: Recruiter lane with two sequenced Actions.
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
const node = (id: string): ProcessNode => ({
  id,
  entity_type: "action",
  name: id,
  lifecycle: "active",
  created_at: null,
  href: null,
  shape: "task",
  laneId: "pool:i1::principal_a",
  pool_id: "pool:i1",
});
const nodes = [node("a1"), node("a2")];
const links = [{ source: "a1", target: "a2", edge_type: "flows_to" }];

function shape(layout: ReturnType<typeof layOutProcess>, id: string) {
  const n = layout.flowNodes.find((fn) => fn.id === id);
  if (!n) throw new Error(`node ${id} not laid out`);
  return n;
}

describe("layOutProcess focal highlight", () => {
  it("highlights and depth-fades around the focal node when highlightFocal is true", () => {
    const layout = layOutProcess(pools, lanes, nodes, links, "a1", new Set(), null, true);
    expect((shape(layout, "a1").data as { isCenter?: boolean }).isCenter).toBe(true);
    // The non-focal node fades (depth > 0 ⇒ opacity < 1).
    expect(Number(shape(layout, "a2").style?.opacity)).toBeLessThan(1);
  });

  it("singles out nothing when highlightFocal is false — whole pool reads uniformly", () => {
    // Same focal node, but a whole-process focus suppresses the highlight: no
    // node is marked center and every node renders at full opacity.
    const layout = layOutProcess(pools, lanes, nodes, links, "a1", new Set(), null, false);
    expect((shape(layout, "a1").data as { isCenter?: boolean }).isCenter).toBe(false);
    expect((shape(layout, "a2").data as { isCenter?: boolean }).isCenter).toBe(false);
    expect(Number(shape(layout, "a1").style?.opacity)).toBe(1);
    expect(Number(shape(layout, "a2").style?.opacity)).toBe(1);
  });

  it("still honors an explicit focusedNodeIds highlight regardless of highlightFocal", () => {
    const layout = layOutProcess(pools, lanes, nodes, links, "a1", new Set(["a2"]), null, false);
    expect((shape(layout, "a2").data as { isCenter?: boolean }).isCenter).toBe(true);
  });
});
