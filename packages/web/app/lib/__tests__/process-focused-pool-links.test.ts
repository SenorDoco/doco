import { describe, expect, it } from "vitest";

import { computeDepthFromCenter } from "../graph-depth";
import { linksWithFocusedPoolMembership } from "../process-focused-pool-links";

describe("linksWithFocusedPoolMembership", () => {
  it("treats every node in the focused process pool as one hop away", () => {
    const pools = [
      { id: "pool:action_p", process_id: "action_p" },
      { id: "pool:action_q", process_id: "action_q" },
    ];
    const nodes = [
      { id: "action_1", pool_id: "pool:action_p" },
      { id: "decision_1", pool_id: "pool:action_p" },
      { id: "action_2", pool_id: "pool:action_q" },
    ];

    const focusLinks = linksWithFocusedPoolMembership(pools, nodes, [], "action_p");
    const depthByNode = computeDepthFromCenter(
      [...nodes.map((node) => ({ id: node.id })), { id: "action_p" }, { id: "action_q" }],
      focusLinks,
      "action_p",
    );

    expect(depthByNode.get("action_1")).toBe(1);
    expect(depthByNode.get("decision_1")).toBe(1);
    expect(depthByNode.get("action_2")).toBeUndefined();
  });

  it("does not add pool membership links when the focus is a rendered node", () => {
    const pools = [{ id: "pool:action_p", process_id: "action_p" }];
    const nodes = [
      { id: "action_1", pool_id: "pool:action_p" },
      { id: "decision_1", pool_id: "pool:action_p" },
    ];

    expect(linksWithFocusedPoolMembership(pools, nodes, [], "action_1")).toEqual([]);
  });

  it("does not duplicate an existing process-to-node link", () => {
    const pools = [{ id: "pool:action_p", process_id: "action_p" }];
    const nodes = [{ id: "action_1", pool_id: "pool:action_p" }];
    const links = [{ source: "action_1", target: "action_p" }];

    expect(linksWithFocusedPoolMembership(pools, nodes, links, "action_p")).toEqual(links);
  });
});
