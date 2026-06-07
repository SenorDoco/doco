import { describe, expect, it } from "vitest";
import { computeExternalNeighbours } from "../process-boundary";

const node = (id: string, poolId: string) => ({ id, pool_id: poolId });
const flow = (source: string, target: string) => ({ source, target, edge_type: "flows_to" });

describe("computeExternalNeighbours", () => {
  it("entry box, node-to-node, when an external flows INTO a member", () => {
    const nodes = [node("m1", "pool:p"), node("e1", "pool:q")];
    expect(computeExternalNeighbours(new Set(["pool:p"]), nodes, [flow("e1", "m1")])).toEqual([
      { id: "e1", direction: "entry", attach: { kind: "node", nodeId: "m1" } },
    ]);
  });

  it("exit box, node-to-node, when a member flows OUT to an external", () => {
    const nodes = [node("m1", "pool:p"), node("e2", "pool:q")];
    expect(computeExternalNeighbours(new Set(["pool:p"]), nodes, [flow("m1", "e2")])).toEqual([
      { id: "e2", direction: "exit", attach: { kind: "node", nodeId: "m1" } },
    ]);
  });

  it("attaches to the TITLE when the in-pool endpoint is the pool's process Action", () => {
    // `pool:act` is owned by Action `act`; an edge touching `act` attaches to the
    // title band, even though `act` itself isn't drawn as a member node.
    const nodes = [node("upstream", "pool:other"), node("downstream", "pool:other")];
    const links = [flow("upstream", "act"), flow("act", "downstream")];
    expect(computeExternalNeighbours(new Set(["pool:act"]), nodes, links)).toEqual([
      { id: "upstream", direction: "entry", attach: { kind: "title", poolId: "pool:act" } },
      { id: "downstream", direction: "exit", attach: { kind: "title", poolId: "pool:act" } },
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
      { id: "ext", direction: "entry", attach: { kind: "node", nodeId: "m1" } },
      { id: "ext", direction: "exit", attach: { kind: "node", nodeId: "m2" } },
    ]);
  });
});
