import { describe, expect, it } from "vitest";
import {
  processExpansionFitNodeId,
  processFocusFlowNodeId,
  processPoolFitNodeIds,
} from "../process-focus-fit";

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

describe("processExpansionFitNodeId", () => {
  const poolIdByProcessId = new Map([
    ["action_parent", "pool:action_parent"],
    ["action_sub", "pool:action_sub"],
  ]);
  const rendered = new Set(["pool-header:pool:action_sub", "lane:pool:action_sub::ops"]);

  it("frames the freshly expanded process's pool header", () => {
    expect(processExpansionFitNodeId("action_sub", null, poolIdByProcessId, rendered)).toBe(
      "pool-header:pool:action_sub",
    );
  });

  it("returns null when nothing is expanded, leaving the camera put", () => {
    expect(processExpansionFitNodeId(null, null, poolIdByProcessId, rendered)).toBeNull();
  });

  it("returns null when the expansion only mirrors the URL focus (cold-open already frames it)", () => {
    expect(
      processExpansionFitNodeId("action_sub", "action_sub", poolIdByProcessId, rendered),
    ).toBeNull();
  });

  it("re-frames a subprocess even when a different node holds the URL focus", () => {
    // "View subprocess" while a parent action is the URL focus must still
    // frame the subprocess's OWN pool, not stay parked on the parent.
    expect(
      processExpansionFitNodeId("action_sub", "action_parent", poolIdByProcessId, rendered),
    ).toBe("pool-header:pool:action_sub");
  });

  it("returns null until the expanded pool's header has actually rendered", () => {
    expect(processExpansionFitNodeId("action_sub", null, poolIdByProcessId, new Set())).toBeNull();
  });

  it("returns null for a process that heads no pool", () => {
    expect(processExpansionFitNodeId("action_ghost", null, poolIdByProcessId, rendered)).toBeNull();
  });
});
