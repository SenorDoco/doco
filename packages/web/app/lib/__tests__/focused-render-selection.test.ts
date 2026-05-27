import { describe, expect, it } from "vitest";
import {
  highestRankedNodeId,
  selectFocusedNodeIds,
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
