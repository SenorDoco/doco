import { describe, expect, it } from "vitest";
import { layOutProcess } from "~/components/perspectives/process-perspective";
import type { ProcessLane, ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

// One actor lane with a two-node chain: `b` follows `a`, so they land in
// adjacent columns (depth 0 → depth 1). The empty horizontal band between
// them is where `flows_to`/condition tags render, so we assert its width.
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
// Identical names keep both nodes the same width, so each sits flush at its
// column slot (zero centering offset) and the gap reduces to the column gap.
const node = (id: string): ProcessNode => ({
  id,
  entity_type: "action",
  name: "Step",
  lifecycle: "active",
  created_at: "2026-05-26T00:00:00.000Z",
  href: null,
  shape: "task",
  laneId: "pool:i1::principal_a",
  pool_id: "pool:i1",
});

function box(
  layout: ReturnType<typeof layOutProcess>,
  id: string,
): { left: number; right: number } {
  const fn = layout.flowNodes.find((n) => n.id === id);
  if (!fn) throw new Error(`node ${id} not laid out`);
  const width = Number(fn.style?.width ?? 0);
  return { left: fn.position.x, right: fn.position.x + width };
}

describe("layOutProcess column spacing", () => {
  it("leaves a 120px gap between adjacent columns for edge tags", () => {
    const nodes = [node("a"), node("b")];
    const links = [{ source: "a", target: "b", edge_type: "flows_to" }];
    const layout = layOutProcess(pools, lanes, nodes, links, "a", new Set(), null, false);

    const a = box(layout, "a");
    const b = box(layout, "b");
    expect(b.left - a.right).toBe(120);
  });
});
