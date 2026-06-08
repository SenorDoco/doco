import { describe, expect, it, vi } from "vitest";
import {
  TOP_LEVEL_POOL_ID,
  clickedExternalNeighbour,
  openCanvasNode,
  resolveCanvasNodeClick,
} from "~/components/perspectives/process-perspective";
import type { ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

const node = (id: string, overrides: Partial<ProcessNode> = {}): ProcessNode => ({
  id,
  entity_type: "action",
  name: id,
  lifecycle: "active",
  created_at: null,
  href: `/doco/action/${id}`,
  shape: "task",
  laneId: "lane_1",
  pool_id: "pool:p1",
  ...overrides,
});

function handlers() {
  return {
    setHomeMode: vi.fn(),
    setExpandedProcessId: vi.fn(),
    onCenterChange: vi.fn(),
    onNodeClick: vi.fn(),
    navigate: vi.fn(),
  };
}

describe("openCanvasNode", () => {
  it("clicking a sub-process Action opens INTO its own pool AND opens its dialog", () => {
    const subprocess = node("sub_1", { is_process: true });
    const h = handlers();
    openCanvasNode(subprocess, h);
    // "open the sub-process" — its own pool frames the canvas…
    expect(h.setExpandedProcessId).toHaveBeenCalledWith("sub_1");
    expect(h.onCenterChange).toHaveBeenCalledWith("sub_1");
    // …and "open the node dialog as usual" — exactly like any node click.
    expect(h.onNodeClick).toHaveBeenCalledWith(subprocess);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.setHomeMode).toHaveBeenCalledWith(false);
  });

  it("clicking an ordinary node collapses to its parent pool but still opens the dialog", () => {
    const member = node("member_1");
    const h = handlers();
    openCanvasNode(member, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
    expect(h.onCenterChange).toHaveBeenCalledWith("member_1");
    expect(h.onNodeClick).toHaveBeenCalledWith(member);
  });

  it("only Actions are sub-processes — a process-flagged Decision does not expand", () => {
    const decision = node("dec_1", { entity_type: "decision", is_process: true });
    const h = handlers();
    openCanvasNode(decision, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
    expect(h.onNodeClick).toHaveBeenCalledWith(decision);
  });

  it("falls back to navigation when no dialog handler is wired", () => {
    const member = node("member_2");
    const h = { ...handlers(), onNodeClick: undefined };
    openCanvasNode(member, h);
    expect(h.navigate).toHaveBeenCalledWith("/doco/action/member_2");
  });
});

describe("resolveCanvasNodeClick", () => {
  const pool = (id: string, process_id: string | null): ProcessPool => ({
    id,
    process_id,
    label: id,
    lifecycle: null,
  });
  const ctx = (nodes: ProcessNode[], pools: ProcessPool[] = []) => ({
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    poolByHeaderId: new Map(pools.map((p) => [`pool-header:${p.id}`, p])),
  });

  it("routes a pool-header click to focusing that whole pool", () => {
    const p = pool("pool:p1", "p1");
    expect(resolveCanvasNodeClick({ id: "pool-header:pool:p1" }, ctx([], [p]))).toEqual({
      kind: "pool",
      pool: p,
    });
  });

  it("routes a parent-process box to drilling UP into that parent's pool", () => {
    expect(resolveCanvasNodeClick({ id: "parent:proc_1::pool:p2" }, ctx([]))).toEqual({
      kind: "parentProcess",
      processId: "proc_1",
    });
  });

  it("routes an external-neighbour box to opening the cross-pool node it stands for", () => {
    const external = node("q1", { pool_id: "pool:other" });
    expect(
      resolveCanvasNodeClick({ id: "external:entry:q1:pool:p", data: { node: external } }, ctx([])),
    ).toEqual({ kind: "node", node: external });
  });

  // The default-view (synthetic overview) entries must render IDENTICALLY to
  // nodes anywhere else: a click is a plain node-open, never a bespoke pool
  // drill-in. A `top_level_process` Action with no children is NOT a process,
  // so opening it must not expand any pool — `openCanvasNode` (below) gates
  // that on `is_process`, exactly as it does everywhere else.
  it("routes an overview entry that is not a process to a plain node-open (no pool view)", () => {
    const entry = node("not_a_process", { pool_id: TOP_LEVEL_POOL_ID });
    const resolved = resolveCanvasNodeClick({ id: "not_a_process" }, ctx([entry]));
    expect(resolved).toEqual({ kind: "node", node: entry });

    // …and feeding that node through the shared open keeps the pool collapsed.
    const h = handlers();
    if (resolved?.kind === "node") openCanvasNode(resolved.node, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
  });

  it("routes an overview entry that IS a process to the shared node-open, which drills in", () => {
    const proc = node("real_process", { pool_id: TOP_LEVEL_POOL_ID, is_process: true });
    const resolved = resolveCanvasNodeClick({ id: "real_process" }, ctx([proc]));
    expect(resolved).toEqual({ kind: "node", node: proc });

    const h = handlers();
    if (resolved?.kind === "node") openCanvasNode(resolved.node, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith("real_process");
  });

  it("returns null when the clicked flow node is not a known node", () => {
    expect(resolveCanvasNodeClick({ id: "ghost" }, ctx([]))).toBeNull();
  });
});

describe("clickedExternalNeighbour", () => {
  it("resolves an external-neighbour box to the cross-pool node it stands for", () => {
    const external = node("q1", { pool_id: "pool:other" });
    expect(
      clickedExternalNeighbour({
        id: "external:entry:q1:pool:action_p",
        data: { node: external },
      }),
    ).toBe(external);
  });

  it("returns null for an ordinary in-pool flow node", () => {
    expect(
      clickedExternalNeighbour({ id: "member_1", data: { node: node("member_1") } }),
    ).toBeNull();
  });

  it("returns null for an external id whose data carries no node", () => {
    expect(clickedExternalNeighbour({ id: "external:entry:q1:pool:p" })).toBeNull();
  });
});
