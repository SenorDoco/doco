import { describe, expect, it } from "vitest";
import {
  highestRankedNodeId,
  processFocusCandidates,
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

  it("includes priority ids ahead of generic rank filler, capped by budget", () => {
    const priorityNodes = [
      { id: "focus", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: "entry", lifecycle: "active", created_at: "2026-01-02T00:00:00Z" },
      { id: "filler-high", lifecycle: "active", created_at: "2026-01-03T00:00:00Z" },
      { id: "filler-low", lifecycle: "active", created_at: "2026-01-04T00:00:00Z" },
    ];
    const priorityLinks = [{ source: "focus", target: "filler-high" }];
    const globalRanks = new Map([
      ["filler-high", 10],
      ["filler-low", 5],
      ["entry", 0.1], // low rank — would normally be crowded out
      ["focus", 0.01],
    ]);

    // Budget 3: focus + one of the high-rank fillers would normally win,
    // but a low-rank entry point marked priority must still make the cut.
    const selected = selectPersonalizedNodeIds(
      priorityNodes,
      priorityLinks,
      "focus",
      globalRanks,
      3,
      { priorityIds: new Set(["entry"]) },
    );

    expect(selected.has("focus")).toBe(true);
    expect(selected.has("entry")).toBe(true);
    expect(selected.size).toBe(3);
  });

  it("never exceeds the budget even when priority ids do not all fit", () => {
    const priorityNodes = [
      { id: "focus", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: "p1", lifecycle: "active", created_at: "2026-01-02T00:00:00Z" },
      { id: "p2", lifecycle: "active", created_at: "2026-01-03T00:00:00Z" },
      { id: "p3", lifecycle: "active", created_at: "2026-01-04T00:00:00Z" },
    ];
    const globalRanks = new Map([
      ["p1", 3],
      ["p2", 2],
      ["p3", 1],
      ["focus", 0.01],
    ]);

    const selected = selectPersonalizedNodeIds(priorityNodes, [], "focus", globalRanks, 2, {
      priorityIds: new Set(["p1", "p2", "p3"]),
    });

    expect(selected.size).toBe(2);
    expect(selected.has("focus")).toBe(true);
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

describe("processFocusCandidates", () => {
  const node = (id: string, lifecycle: string) => ({ id, lifecycle, created_at: null });
  const filteredNodes = [node("step-1", "active")];
  const pools = [
    { intent_id: "intent-live", lifecycle: "drafting" },
    { intent_id: "intent-dead", lifecycle: "retired" },
  ];
  // Out-of-the-box lifecycle filter: retired hidden; drafting, queued + active shown.
  const defaultVisible = new Set(["drafting", "queued", "active"]);

  it("offers pool intents whose lifecycle is visible", () => {
    const ids = processFocusCandidates(filteredNodes, pools, defaultVisible).map((n) => n.id);
    expect(ids).toContain("intent-live");
  });

  it("excludes a retired pool intent while retired is hidden, like a retired node", () => {
    const ids = processFocusCandidates(filteredNodes, pools, defaultVisible).map((n) => n.id);
    expect(ids).not.toContain("intent-dead");
  });

  it("offers a retired pool intent once retired is toggled visible", () => {
    const visible = new Set(["drafting", "queued", "active", "retired"]);
    const ids = processFocusCandidates(filteredNodes, pools, visible).map((n) => n.id);
    expect(ids).toContain("intent-dead");
  });

  it("offers every pool intent when no lifecycle filter is set", () => {
    const ids = processFocusCandidates(filteredNodes, pools, undefined).map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["intent-live", "intent-dead"]));
  });

  it("a hidden retired pool no longer steals the default focus from a visible node", () => {
    // The retired pool carries the top PageRank, but it's hidden — so the
    // highest-ranked *visible* candidate must win the cold-open focus.
    const ranks = new Map([
      ["intent-dead", 0.9],
      ["intent-live", 0.5],
      ["step-1", 0.1],
    ]);
    const candidates = processFocusCandidates(filteredNodes, pools, defaultVisible);
    expect(highestRankedNodeId(candidates, ranks)).toBe("intent-live");
  });
});
