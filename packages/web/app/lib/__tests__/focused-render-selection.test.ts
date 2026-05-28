import { describe, expect, it } from "vitest";
import {
  highestRankedNodeId,
  selectFocusedNodeIds,
  selectPersonalizedNodeIds,
  summarizeExternalConnections,
} from "../focused-render-selection";

describe("focused render selection", () => {
  const nodes = [
    { id: "a", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
    { id: "b", lifecycle: "active", created_at: "2026-01-02T00:00:00Z" },
    { id: "c", lifecycle: "drafting", created_at: "2026-01-03T00:00:00Z" },
    { id: "d", lifecycle: "active", created_at: "2026-01-04T00:00:00Z" },
    { id: "e", lifecycle: "active", created_at: "2026-01-05T00:00:00Z" },
  ];
  const ranks = new Map([
    ["a", 0.01],
    ["b", 0.9],
    ["c", 0.3],
    ["d", 0.2],
    ["e", 0.1],
  ]);
  const links = [
    { source: "b", target: "c" },
    { source: "c", target: "d" },
    { source: "a", target: "e" },
  ];

  it("defaults focus to the highest PageRank node", () => {
    expect(highestRankedNodeId(nodes, ranks)).toBe("b");
    expect(Array.from(selectFocusedNodeIds(nodes, links, null, ranks, 3))).toEqual(["b", "c", "d"]);
  });

  it("keeps the requested focus and fills by graph distance then rank", () => {
    expect(Array.from(selectFocusedNodeIds(nodes, links, "a", ranks, 3))).toEqual(["a", "e", "b"]);
  });

  it("fills the focused window by personalized PageRank from the focus", () => {
    const personalNodes = [
      { id: "focus", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: "near", lifecycle: "active", created_at: "2026-01-02T00:00:00Z" },
      { id: "far", lifecycle: "active", created_at: "2026-01-03T00:00:00Z" },
      { id: "global", lifecycle: "active", created_at: "2026-01-04T00:00:00Z" },
    ];
    const personalLinks = [
      { source: "focus", target: "near" },
      { source: "near", target: "far" },
    ];
    const globalRanks = new Map([
      ["global", 10],
      ["far", 1],
      ["near", 0.5],
      ["focus", 0.1],
    ]);

    expect(
      Array.from(selectPersonalizedNodeIds(personalNodes, personalLinks, "focus", globalRanks, 3)),
    ).toEqual(["focus", "near", "far"]);
  });

  it("reserves requested first-degree neighbors before filling by rank", () => {
    const quotaNodes = [
      { id: "focus", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: "incoming", lifecycle: "active", created_at: "2026-01-02T00:00:00Z" },
      { id: "outgoing", lifecycle: "active", created_at: "2026-01-03T00:00:00Z" },
      { id: "second-degree", lifecycle: "active", created_at: "2026-01-04T00:00:00Z" },
    ];
    const quotaLinks = [
      { source: "incoming", target: "focus" },
      { source: "focus", target: "outgoing" },
      { source: "outgoing", target: "second-degree" },
    ];
    const globalRanks = new Map([
      ["second-degree", 10],
      ["incoming", 0.2],
      ["outgoing", 0.1],
      ["focus", 0.01],
    ]);

    const selected = Array.from(
      selectPersonalizedNodeIds(quotaNodes, quotaLinks, "focus", globalRanks, 4, {
        minFirstDegree: 2,
      }),
    );

    expect(selected[0]).toBe("focus");
    expect(new Set(selected.slice(1, 3))).toEqual(new Set(["incoming", "outgoing"]));
    expect(selected).toContain("second-degree");
  });

  it("can reserve first-degree neighbors when the focus is not renderable", () => {
    const quotaNodes = [
      { id: "pool-node-a", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: "pool-node-b", lifecycle: "active", created_at: "2026-01-02T00:00:00Z" },
      { id: "outside", lifecycle: "active", created_at: "2026-01-03T00:00:00Z" },
    ];
    const quotaLinks = [
      { source: "intent-pool", target: "pool-node-a" },
      { source: "pool-node-b", target: "intent-pool" },
    ];
    const globalRanks = new Map([
      ["outside", 10],
      ["pool-node-a", 0.2],
      ["pool-node-b", 0.1],
    ]);

    const selected = Array.from(
      selectPersonalizedNodeIds(quotaNodes, quotaLinks, "intent-pool", globalRanks, 3, {
        minFirstDegree: 2,
      }),
    );

    expect(new Set(selected.slice(0, 2))).toEqual(new Set(["pool-node-a", "pool-node-b"]));
    expect(selected).toContain("outside");
  });

  it("summarizes links that leave the rendered working set", () => {
    expect(summarizeExternalConnections(links, new Set(["b", "d"]))).toEqual([
      { id: "b", incoming: 0, outgoing: 1 },
      { id: "d", incoming: 1, outgoing: 0 },
    ]);
  });

  it("ignores links to nodes that are not renderable in the perspective", () => {
    const perspectiveLinks = [
      { source: "b", target: "intent-pool-header" },
      { source: "b", target: "c" },
    ];

    expect(
      summarizeExternalConnections(perspectiveLinks, new Set(["b"]), new Set(["b", "c"])),
    ).toEqual([{ id: "b", incoming: 0, outgoing: 1 }]);
  });
});
