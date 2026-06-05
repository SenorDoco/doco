import { describe, expect, it } from "vitest";
import { processFocusFlowNodeId, processPoolFitNodeIds } from "../process-focus-fit";

describe("processPoolFitNodeIds", () => {
  const laneFlowNodeId = (id: string) => `lane:${id}`;
  const lanes = [
    { id: "poolA::talent", pool_id: "poolA" },
    { id: "poolA::torre", pool_id: "poolA" },
    { id: "poolB::ops", pool_id: "poolB" },
  ];
  const rendered = new Set([
    "pool-header:poolA",
    "lane:poolA::talent",
    "lane:poolA::torre",
    "pool-header:poolB",
    "lane:poolB::ops",
  ]);

  it("returns null for a non-pool target, keeping single-node zoom", () => {
    expect(processPoolFitNodeIds("action_123", lanes, laneFlowNodeId, rendered)).toBeNull();
  });

  it("fits the pool header plus every lane in that pool", () => {
    expect(processPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, rendered)).toEqual([
      "pool-header:poolA",
      "lane:poolA::talent",
      "lane:poolA::torre",
    ]);
  });

  it("excludes lanes that belong to other pools", () => {
    expect(
      processPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, rendered),
    ).not.toContain("lane:poolB::ops");
  });

  it("drops fit targets that are not currently rendered", () => {
    const partial = new Set(["pool-header:poolA", "lane:poolA::talent"]);
    expect(processPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, partial)).toEqual([
      "pool-header:poolA",
      "lane:poolA::talent",
    ]);
  });
});

describe("processFocusFlowNodeId", () => {
  const poolIdByIntentId = new Map([
    ["intent_a", "pool:intent_a"],
    ["intent_b", "pool:intent_b"],
  ]);
  const rendered = new Set(["pool-header:pool:intent_a", "action_99"]);

  it("frames the whole pool for an Intent target (its header, not an entry step)", () => {
    expect(processFocusFlowNodeId("intent_a", poolIdByIntentId, rendered)).toBe(
      "pool-header:pool:intent_a",
    );
  });

  it("frames the node itself for a non-Intent target", () => {
    expect(processFocusFlowNodeId("action_99", poolIdByIntentId, rendered)).toBe("action_99");
  });

  it("returns null when neither the Intent's pool header nor the node is rendered", () => {
    expect(processFocusFlowNodeId("intent_b", poolIdByIntentId, rendered)).toBeNull();
    expect(processFocusFlowNodeId("decision_x", poolIdByIntentId, rendered)).toBeNull();
  });
});
