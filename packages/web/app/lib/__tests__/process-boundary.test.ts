import { describe, expect, it } from "vitest";
import { computeExternalNeighbours, computeParentProcesses } from "../process-boundary";

const node = (id: string, poolId: string) => ({ id, pool_id: poolId });
const flow = (source: string, target: string, label: string | null = null) => ({
  source,
  target,
  edge_type: "flows_to",
  label,
});
const hasParent = (child: string, parent: string) => ({
  source: child,
  target: parent,
  edge_type: "has_parent",
});

describe("computeExternalNeighbours", () => {
  it("entry box, node-to-node, when an external flows INTO a member", () => {
    const nodes = [node("m1", "pool:p"), node("e1", "pool:q")];
    expect(computeExternalNeighbours(new Set(["pool:p"]), nodes, [flow("e1", "m1")])).toEqual([
      {
        id: "e1",
        direction: "entry",
        attach: { kind: "node", nodeId: "m1" },
        edgeType: "flows_to",
        label: null,
      },
    ]);
  });

  it("exit box, node-to-node, when a member flows OUT to an external", () => {
    const nodes = [node("m1", "pool:p"), node("e2", "pool:q")];
    expect(computeExternalNeighbours(new Set(["pool:p"]), nodes, [flow("m1", "e2")])).toEqual([
      {
        id: "e2",
        direction: "exit",
        attach: { kind: "node", nodeId: "m1" },
        edgeType: "flows_to",
        label: null,
      },
    ]);
  });

  it("carries the edge type and condition so the boundary arrow can still show its tag", () => {
    // A cross-pool flow reads like an in-pool one: the renderer needs the edge
    // type (and any branch condition) to label the arrow, so the neighbour
    // carries both. This is what keeps the tag from going missing on the
    // entry/exit arrows.
    const nodes = [node("m1", "pool:p"), node("e1", "pool:q")];
    expect(
      computeExternalNeighbours(new Set(["pool:p"]), nodes, [flow("e1", "m1", "Yes")]),
    ).toEqual([
      {
        id: "e1",
        direction: "entry",
        attach: { kind: "node", nodeId: "m1" },
        edgeType: "flows_to",
        label: "Yes",
      },
    ]);
  });

  it("attaches to the TITLE when the in-pool endpoint is the pool's process Action", () => {
    // `pool:act` is owned by Action `act`; an edge touching `act` attaches to the
    // title band, even though `act` itself isn't drawn as a member node.
    const nodes = [node("upstream", "pool:other"), node("downstream", "pool:other")];
    const links = [flow("upstream", "act"), flow("act", "downstream")];
    expect(computeExternalNeighbours(new Set(["pool:act"]), nodes, links)).toEqual([
      {
        id: "upstream",
        direction: "entry",
        attach: { kind: "title", poolId: "pool:act" },
        edgeType: "flows_to",
        label: null,
      },
      {
        id: "downstream",
        direction: "exit",
        attach: { kind: "title", poolId: "pool:act" },
        edgeType: "flows_to",
        label: null,
      },
    ]);
  });

  it("ignores internal flow and non-flows_to edges", () => {
    const nodes = [node("m1", "pool:p"), node("m2", "pool:p"), node("e1", "pool:q")];
    const links = [flow("m1", "m2"), { source: "e1", target: "m1", edge_type: "supports" }];
    expect(computeExternalNeighbours(new Set(["pool:p"]), nodes, links)).toEqual([]);
  });

  it("skips an external whose node is unknown (can't render its box)", () => {
    const nodes = [node("m1", "pool:p")];
    expect(computeExternalNeighbours(new Set(["pool:p"]), nodes, [flow("m1", "ghost")])).toEqual(
      [],
    );
  });

  it("de-duplicates a repeated edge and sorts entries before exits", () => {
    const nodes = [node("m1", "pool:p"), node("m2", "pool:p"), node("ext", "pool:q")];
    const links = [flow("ext", "m1"), flow("m2", "ext"), flow("m2", "ext")];
    expect(computeExternalNeighbours(new Set(["pool:p"]), nodes, links)).toEqual([
      {
        id: "ext",
        direction: "entry",
        attach: { kind: "node", nodeId: "m1" },
        edgeType: "flows_to",
        label: null,
      },
      {
        id: "ext",
        direction: "exit",
        attach: { kind: "node", nodeId: "m2" },
        edgeType: "flows_to",
        label: null,
      },
    ]);
  });
});

describe("computeParentProcesses", () => {
  it("reports the parent process a focal pool's Action hangs under", () => {
    // pool:child is owned by Action `child`; `child` points at Action `parent`
    // through `has_parent`, so `parent` is its parent process.
    expect(computeParentProcesses(new Set(["pool:child"]), [hasParent("child", "parent")])).toEqual(
      [{ poolId: "pool:child", id: "parent", edgeType: "has_parent" }],
    );
  });

  it("carries the has_parent edge type so the hierarchy arrow always shows its tag", () => {
    // The arrow rising into a parent box is a `has_parent` edge; carrying its
    // type is what lets the renderer label it instead of leaving it bare.
    const [parent] = computeParentProcesses(new Set(["pool:child"]), [
      hasParent("child", "parent"),
    ]);
    expect(parent.edgeType).toBe("has_parent");
  });

  it("reports EVERY parent — an Action can belong to multiple processes", () => {
    // `child` has two `has_parent` edges, so it belongs to two processes; both
    // are surfaced, sorted by parent id.
    const links = [hasParent("child", "p2"), hasParent("child", "p1")];
    expect(computeParentProcesses(new Set(["pool:child"]), links)).toEqual([
      { poolId: "pool:child", id: "p1", edgeType: "has_parent" },
      { poolId: "pool:child", id: "p2", edgeType: "has_parent" },
    ]);
  });

  it("ignores has_parent edges from Actions that don't head the focal pool", () => {
    // Only `child` heads the focal pool; `other`'s parentage is irrelevant here.
    const links = [hasParent("child", "parent"), hasParent("other", "elsewhere")];
    expect(computeParentProcesses(new Set(["pool:child"]), links)).toEqual([
      { poolId: "pool:child", id: "parent", edgeType: "has_parent" },
    ]);
  });

  it("ignores non-has_parent edges", () => {
    const links = [
      flow("child", "parent"),
      { source: "child", target: "g", edge_type: "supports" },
    ];
    expect(computeParentProcesses(new Set(["pool:child"]), links)).toEqual([]);
  });

  it("de-duplicates a repeated has_parent edge", () => {
    const links = [hasParent("child", "parent"), hasParent("child", "parent")];
    expect(computeParentProcesses(new Set(["pool:child"]), links)).toEqual([
      { poolId: "pool:child", id: "parent", edgeType: "has_parent" },
    ]);
  });

  it("reports parents for every focal pool when two are framed at once", () => {
    const links = [hasParent("c1", "p1"), hasParent("c2", "p2")];
    expect(computeParentProcesses(new Set(["pool:c1", "pool:c2"]), links)).toEqual([
      { poolId: "pool:c1", id: "p1", edgeType: "has_parent" },
      { poolId: "pool:c2", id: "p2", edgeType: "has_parent" },
    ]);
  });
});
