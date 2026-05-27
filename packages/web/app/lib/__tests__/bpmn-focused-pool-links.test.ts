import { describe, expect, it } from "vitest";

import { linksWithFocusedPoolMembership } from "../bpmn-focused-pool-links";
import { computeDepthFromCenter } from "../graph-depth";

describe("linksWithFocusedPoolMembership", () => {
  it("treats every node in the focused intent pool as one hop away", () => {
    const pools = [
      { id: "pool_intent", intent_id: "intent_1" },
      { id: "pool_other", intent_id: "intent_2" },
    ];
    const nodes = [
      { id: "action_1", pool_id: "pool_intent" },
      { id: "decision_1", pool_id: "pool_intent" },
      { id: "action_2", pool_id: "pool_other" },
    ];

    const focusLinks = linksWithFocusedPoolMembership(pools, nodes, [], "intent_1");
    const depthByNode = computeDepthFromCenter(
      [...nodes.map((node) => ({ id: node.id })), { id: "intent_1" }, { id: "intent_2" }],
      focusLinks,
      "intent_1",
    );

    expect(depthByNode.get("action_1")).toBe(1);
    expect(depthByNode.get("decision_1")).toBe(1);
    expect(depthByNode.get("action_2")).toBeUndefined();
  });

  it("does not add pool membership links when the focus is a rendered node", () => {
    const pools = [{ id: "pool_intent", intent_id: "intent_1" }];
    const nodes = [
      { id: "action_1", pool_id: "pool_intent" },
      { id: "decision_1", pool_id: "pool_intent" },
    ];

    expect(linksWithFocusedPoolMembership(pools, nodes, [], "action_1")).toEqual([]);
  });

  it("does not duplicate an existing intent-to-node link", () => {
    const pools = [{ id: "pool_intent", intent_id: "intent_1" }];
    const nodes = [{ id: "action_1", pool_id: "pool_intent" }];
    const links = [{ source: "action_1", target: "intent_1" }];

    expect(linksWithFocusedPoolMembership(pools, nodes, links, "intent_1")).toEqual(links);
  });
});
