import { describe, expect, it } from "vitest";
import type { OverviewGraphLink } from "~/components/overview-graph";
import {
  isWholeProcessFocus,
  resolveProcessCenter,
} from "~/components/perspectives/process-perspective";
import type { ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

const node = (id: string, poolId: string): ProcessNode => ({
  id,
  node_type: "action",
  name: id,
  lifecycle: "active",
  created_at: null,
  href: null,
  shape: "task",
  laneId: `${poolId}::principal_a`,
  pool_id: poolId,
});

// a2 is a step inside pool:p1 and itself heads the subprocess pool:a2.
const pools: ProcessPool[] = [
  { id: "pool:p1", process_id: "p1", label: "Hire", lifecycle: "active" },
  { id: "pool:a2", process_id: "a2", label: "Interview", lifecycle: "active" },
];
const nodes: ProcessNode[] = [
  node("a1", "pool:p1"),
  node("a2", "pool:p1"),
  node("s1", "pool:a2"),
  node("s2", "pool:a2"),
];
const links: OverviewGraphLink[] = [
  { id: "e:a1-a2", source: "a1", target: "a2", edge_type: "flows_to" },
  { id: "e:s1-s2", source: "s1", target: "s2", edge_type: "flows_to" },
];

describe("resolveProcessCenter", () => {
  it("keeps a subprocess step's focus on the step (a plain click never drills in)", () => {
    // The bug: focusing a2 used to remap to its own pool's entry (s1), which
    // drilled the whole canvas into the subprocess. It must stay on a2.
    expect(resolveProcessCenter("a2", { expandedProcessId: null, pools, nodes, links })).toBe("a2");
  });

  it("returns the process id while it is expanded, so its own pool frames", () => {
    expect(resolveProcessCenter("a2", { expandedProcessId: "a2", pools, nodes, links })).toBe("a2");
  });

  it("homes a process that is NOT a rendered step onto its pool's entry point", () => {
    // p1 heads pool:p1 but is not itself a member node — focusing it drills to a1.
    expect(resolveProcessCenter("p1", { expandedProcessId: null, pools, nodes, links })).toBe("a1");
  });

  it("passes a plain node through unchanged", () => {
    expect(resolveProcessCenter("a1", { expandedProcessId: null, pools, nodes, links })).toBe("a1");
  });

  it("returns null for an empty center", () => {
    expect(resolveProcessCenter(null, { expandedProcessId: null, pools, nodes, links })).toBeNull();
  });
});

describe("isWholeProcessFocus", () => {
  it("treats a plain click on a subprocess STEP as a node focus (so it bolds like any node)", () => {
    // The bug: a2's id doubles as its own pool's process_id, so the old
    // `pools.some(p => p.process_id === id)` test read this as a whole-process
    // focus and suppressed the highlight. A subprocess step is a NODE focus.
    expect(isWholeProcessFocus("a2", { expandedProcessId: null, pools, nodes })).toBe(false);
  });

  it("treats an expanded subprocess as a whole-process focus (its own pool frames)", () => {
    expect(isWholeProcessFocus("a2", { expandedProcessId: "a2", pools, nodes })).toBe(true);
  });

  it("treats a pool header (a process_id with no member step) as a whole-process focus", () => {
    expect(isWholeProcessFocus("p1", { expandedProcessId: null, pools, nodes })).toBe(true);
  });

  it("treats a plain node as a node focus", () => {
    expect(isWholeProcessFocus("a1", { expandedProcessId: null, pools, nodes })).toBe(false);
  });

  it("treats an empty center as no focus", () => {
    expect(isWholeProcessFocus(null, { expandedProcessId: null, pools, nodes })).toBe(false);
  });
});
