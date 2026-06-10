import { describe, expect, it, vi } from "vitest";
import {
  TOP_LEVEL_POOL_ID,
  clickedBoundaryNode,
  openCanvasNode,
  resolveCanvasNodeClick,
} from "~/components/perspectives/process-perspective";
import type { ProcessNode, ProcessPool } from "~/lib/process-perspective.server";

const node = (id: string, overrides: Partial<ProcessNode> = {}): ProcessNode => ({
  id,
  node_type: "action",
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
  it("a plain click on a sub-process Action keeps it collapsed in its parent pool — only its dialog opens", () => {
    const subprocess = node("sub_1", { is_process: true });
    const h = handlers();
    openCanvasNode(subprocess, { expandSubprocess: false }, h);
    // A plain click does NOT open the sub-process's own pool…
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
    expect(h.onCenterChange).toHaveBeenCalledWith("sub_1");
    // …it just focuses and opens the node dialog, like any other node click.
    expect(h.onNodeClick).toHaveBeenCalledWith(subprocess);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.setHomeMode).toHaveBeenCalledWith(false);
  });

  it("the View subprocess affordance opens a sub-process INTO its own pool AND opens its dialog", () => {
    const subprocess = node("sub_1", { is_process: true });
    const h = handlers();
    openCanvasNode(subprocess, { expandSubprocess: true }, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith("sub_1");
    expect(h.onCenterChange).toHaveBeenCalledWith("sub_1");
    expect(h.onNodeClick).toHaveBeenCalledWith(subprocess);
  });

  it("clicking an ordinary node collapses to its parent pool but still opens the dialog", () => {
    const member = node("member_1");
    const h = handlers();
    openCanvasNode(member, { expandSubprocess: false }, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
    expect(h.onCenterChange).toHaveBeenCalledWith("member_1");
    expect(h.onNodeClick).toHaveBeenCalledWith(member);
  });

  it("only Action sub-processes expand — a process-flagged Decision never opens a pool, even via the affordance", () => {
    const decision = node("dec_1", { node_type: "decision", is_process: true });
    const h = handlers();
    openCanvasNode(decision, { expandSubprocess: true }, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
    expect(h.onNodeClick).toHaveBeenCalledWith(decision);
  });

  it("falls back to navigation when no dialog handler is wired", () => {
    const member = node("member_2");
    const h = { ...handlers(), onNodeClick: undefined };
    openCanvasNode(member, { expandSubprocess: false }, h);
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

  it("routes a parent-process box to a boundary peek — its body opens the dialog, not a drill", () => {
    // The body click is a pure peek: it resolves to the parent node so the
    // dialog opens, but NOT to a drill (the box's "View process" button does
    // that). So the kind is boundaryNode, not a re-centering node open.
    const parent = node("proc_1", { is_process: true });
    expect(
      resolveCanvasNodeClick({ id: "parent:proc_1::pool:p2", data: { node: parent } }, ctx([])),
    ).toEqual({ kind: "boundaryNode", node: parent });
  });

  it("routes an external-neighbour box to a boundary peek, not a re-centering open", () => {
    const external = node("q1", { pool_id: "pool:other" });
    expect(
      resolveCanvasNodeClick({ id: "external:entry:q1:pool:p", data: { node: external } }, ctx([])),
    ).toEqual({ kind: "boundaryNode", node: external });
  });

  // The default-view (synthetic overview) entries must render and behave
  // IDENTICALLY to nodes anywhere else: a click is a plain node-open, never a
  // bespoke pool drill-in. Clicking the body focuses the node; only the "View
  // subprocess" affordance opens a pool — and only for an Action sub-process.
  it("routes an overview entry that is not a process to a plain node-open (no pool view)", () => {
    const entry = node("not_a_process", { pool_id: TOP_LEVEL_POOL_ID });
    const resolved = resolveCanvasNodeClick({ id: "not_a_process" }, ctx([entry]));
    expect(resolved).toEqual({ kind: "node", node: entry });

    // …and feeding that node through the shared open keeps the pool collapsed.
    const h = handlers();
    if (resolved?.kind === "node") openCanvasNode(resolved.node, { expandSubprocess: false }, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
  });

  it("clicking the body of an overview entry that IS a process keeps its pool collapsed", () => {
    const proc = node("real_process", { pool_id: TOP_LEVEL_POOL_ID, is_process: true });
    const resolved = resolveCanvasNodeClick({ id: "real_process" }, ctx([proc]));
    expect(resolved).toEqual({ kind: "node", node: proc });

    // A plain click — even on a real process — does NOT open its pool; only the
    // "View subprocess" affordance (expandSubprocess) does.
    const collapsed = handlers();
    if (resolved?.kind === "node")
      openCanvasNode(resolved.node, { expandSubprocess: false }, collapsed);
    expect(collapsed.setExpandedProcessId).toHaveBeenCalledWith(null);

    const expanded = handlers();
    if (resolved?.kind === "node")
      openCanvasNode(resolved.node, { expandSubprocess: true }, expanded);
    expect(expanded.setExpandedProcessId).toHaveBeenCalledWith("real_process");
  });

  it("returns null when the clicked flow node is not a known node", () => {
    expect(resolveCanvasNodeClick({ id: "ghost" }, ctx([]))).toBeNull();
  });
});

describe("clickedBoundaryNode", () => {
  it("resolves an external-neighbour box to the cross-pool node it stands for", () => {
    const external = node("q1", { pool_id: "pool:other" });
    expect(
      clickedBoundaryNode({ id: "external:entry:q1:pool:action_p", data: { node: external } }),
    ).toBe(external);
  });

  it("resolves a parent-process box to the parent node it stands for", () => {
    const parent = node("proc_1", { is_process: true });
    expect(clickedBoundaryNode({ id: "parent:proc_1::pool:p2", data: { node: parent } })).toBe(
      parent,
    );
  });

  it("returns null for an ordinary in-pool flow node", () => {
    expect(clickedBoundaryNode({ id: "member_1", data: { node: node("member_1") } })).toBeNull();
  });

  it("returns null for a boundary id whose data carries no node", () => {
    expect(clickedBoundaryNode({ id: "external:entry:q1:pool:p" })).toBeNull();
  });
});
