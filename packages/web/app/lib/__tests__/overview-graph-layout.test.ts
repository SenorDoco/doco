import { describe, expect, it } from "vitest";
import { clusteredForceLayout, layoutOverviewGraphNodes } from "../overview-graph-layout";

const nodes = ["focus", "a", "b", "c", "d", "e", "f"].map((id) => ({
  id,
  entity_type: "idea",
}));

function link(source: string, target: string, synapse_type = "serves") {
  return { source, target, synapse_type };
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

  it("preserves the stable single-ring fallback when auto reorder is off", () => {
    const positions = layoutOverviewGraphNodes(
      nodes.slice(0, 4),
      [link("focus", "a")],
      "focus",
      false,
    );

    expect(positions.get("focus")).toEqual({ x: 0, y: 0 });
    expect(Math.round(distance(positions, "focus", "a"))).toBe(220);
    expect(Math.round(distance(positions, "focus", "b"))).toBe(220);
    expect(Math.round(distance(positions, "focus", "c"))).toBe(220);
  });
});
