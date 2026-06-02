import { describe, expect, it } from "vitest";
import { clusteredForceLayout, layoutOverviewGraphNodes } from "../overview-graph-layout";

const nodes = ["focus", "a", "b", "c", "d", "e", "f"].map((id) => ({
  id,
  entity_type: "idea",
}));

function link(source: string, target: string, edge_type = "supports") {
  return { source, target, edge_type };
}

function distance(positions: Map<string, { x: number; y: number }>, a: string, b: string): number {
  const pa = positions.get(a);
  const pb = positions.get(b);
  if (!pa || !pb) throw new Error(`Missing position for ${a} or ${b}`);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

describe("overview graph layout", () => {
  it("keeps linked communities closer than unrelated communities", () => {
    const positions = clusteredForceLayout(
      nodes,
      [
        link("focus", "a"),
        link("a", "b"),
        link("b", "focus"),
        link("c", "d"),
        link("d", "e"),
        link("e", "f"),
        link("f", "c"),
      ],
      "focus",
    );

    const focusCommunity = (distance(positions, "focus", "a") + distance(positions, "a", "b")) / 2;
    const otherCommunity = (distance(positions, "c", "d") + distance(positions, "e", "f")) / 2;
    const crossCommunity = (distance(positions, "a", "c") + distance(positions, "b", "d")) / 2;

    expect(focusCommunity).toBeLessThan(crossCommunity * 0.55);
    expect(otherCommunity).toBeLessThan(crossCommunity * 0.55);
  });

  it("routes overview graph layout through the clustered relevance layout", () => {
    const positions = layoutOverviewGraphNodes(
      nodes,
      [
        link("focus", "a"),
        link("a", "b"),
        link("b", "focus"),
        link("c", "d"),
        link("d", "e"),
        link("e", "f"),
        link("f", "c"),
      ],
      "focus",
    );

    const focusCommunity = (distance(positions, "focus", "a") + distance(positions, "a", "b")) / 2;
    const otherCommunity = (distance(positions, "c", "d") + distance(positions, "e", "f")) / 2;
    const crossCommunity = (distance(positions, "a", "c") + distance(positions, "b", "d")) / 2;

    expect(focusCommunity).toBeLessThan(crossCommunity * 0.55);
    expect(otherCommunity).toBeLessThan(crossCommunity * 0.55);
  });

  it("keeps a deterministic ring fallback for tiny render windows", () => {
    const positions = layoutOverviewGraphNodes(nodes.slice(0, 2), [link("focus", "a")], "focus");

    expect(positions.get("focus")).toEqual({ x: 0, y: 0 });
    expect(Math.round(distance(positions, "focus", "a"))).toBe(220);
  });

  it("keeps small disconnected render windows compact", () => {
    const positions = layoutOverviewGraphNodes(nodes.slice(0, 5), [], "focus");

    expect(positions.get("focus")).toEqual({ x: 0, y: 0 });
    for (const node of nodes.slice(1, 5)) {
      expect(Math.round(distance(positions, "focus", node.id))).toBeLessThanOrEqual(260);
    }
  });

  it("keeps small disconnected components near the focal component", () => {
    const positions = layoutOverviewGraphNodes(nodes.slice(0, 5), [link("focus", "a")], "focus");

    expect(positions.get("focus")).toEqual({ x: 0, y: 0 });
    for (const node of nodes.slice(1, 5)) {
      expect(Math.round(distance(positions, "focus", node.id))).toBeLessThanOrEqual(360);
    }
  });

  it("uses deterministic depth rings for 100-node render windows", () => {
    const largeNodes = [
      { id: "focus", entity_type: "idea" },
      ...Array.from({ length: 99 }, (_, index) => ({
        id: `n${String(index + 1).padStart(3, "0")}`,
        entity_type: "idea",
      })),
    ];
    const chainLinks = Array.from({ length: 99 }, (_, index) =>
      index === 0
        ? link("focus", "n001")
        : link(`n${String(index).padStart(3, "0")}`, `n${String(index + 1).padStart(3, "0")}`),
    );

    const positions = layoutOverviewGraphNodes(largeNodes, chainLinks, "focus");

    expect(positions.get("focus")).toEqual({ x: 0, y: 0 });
    expect(Math.round(distance(positions, "focus", "n001"))).toBe(220);
    expect(Math.round(distance(positions, "focus", "n002"))).toBe(400);
  });
});
