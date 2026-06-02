import { describe, expect, it } from "vitest";
import { bpmnPoolFitNodeIds } from "../bpmn-focus-fit";

describe("bpmnPoolFitNodeIds", () => {
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
    expect(bpmnPoolFitNodeIds("action_123", lanes, laneFlowNodeId, rendered)).toBeNull();
  });

  it("fits the pool header plus every lane in that pool", () => {
    expect(bpmnPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, rendered)).toEqual([
      "pool-header:poolA",
      "lane:poolA::talent",
      "lane:poolA::torre",
    ]);
  });

  it("excludes lanes that belong to other pools", () => {
    expect(bpmnPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, rendered)).not.toContain(
      "lane:poolB::ops",
    );
  });

  it("drops fit targets that are not currently rendered", () => {
    const partial = new Set(["pool-header:poolA", "lane:poolA::talent"]);
    expect(bpmnPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, partial)).toEqual([
      "pool-header:poolA",
      "lane:poolA::talent",
    ]);
  });
});
