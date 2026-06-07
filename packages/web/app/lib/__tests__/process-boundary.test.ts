import { describe, expect, it } from "vitest";
import { computeBoundaryCircles } from "../process-boundary";

const node = (id: string, poolId: string) => ({ id, pool_id: poolId });
const flow = (source: string, target: string) => ({ source, target, edge_type: "flows_to" });

describe("computeBoundaryCircles", () => {
  it("draws an entry circle for an external node that flows INTO the focal pool", () => {
    const nodes = [node("m1", "pool:p"), node("e1", "pool:q")];
    const links = [flow("e1", "m1")];
    expect(computeBoundaryCircles(new Set(["pool:p"]), nodes, links)).toEqual([
      { id: "e1", direction: "entry" },
    ]);
  });

  it("draws an exit circle for an external node the focal pool flows OUT to", () => {
    const nodes = [node("m1", "pool:p"), node("e2", "pool:q")];
    const links = [flow("m1", "e2")];
    expect(computeBoundaryCircles(new Set(["pool:p"]), nodes, links)).toEqual([
      { id: "e2", direction: "exit" },
    ]);
  });

  it("ignores sequence flow that stays inside the focal pool", () => {
    const nodes = [node("m1", "pool:p"), node("m2", "pool:p")];
    const links = [flow("m1", "m2")];
    expect(computeBoundaryCircles(new Set(["pool:p"]), nodes, links)).toEqual([]);
  });

  it("only considers flows_to, never association edges", () => {
    const nodes = [node("m1", "pool:p"), node("e1", "pool:q")];
    const links = [{ source: "e1", target: "m1", edge_type: "supports" }];
    expect(computeBoundaryCircles(new Set(["pool:p"]), nodes, links)).toEqual([]);
  });

  it("skips endpoints whose node (and thus pool) is unknown", () => {
    const nodes = [node("m1", "pool:p")];
    const links = [flow("ghost", "m1"), flow("m1", "phantom")];
    expect(computeBoundaryCircles(new Set(["pool:p"]), nodes, links)).toEqual([]);
  });

  it("de-duplicates and sorts by direction then id across two focal pools", () => {
    const nodes = [
      node("m1", "pool:p"),
      node("m2", "pool:p2"),
      node("ext", "pool:q"),
    ];
    // `ext` both feeds m1 (entry) and twice receives from m2 (exit, deduped).
    const links = [flow("ext", "m1"), flow("m2", "ext"), flow("m2", "ext")];
    expect(computeBoundaryCircles(new Set(["pool:p", "pool:p2"]), nodes, links)).toEqual([
      { id: "ext", direction: "entry" },
      { id: "ext", direction: "exit" },
    ]);
  });
});
