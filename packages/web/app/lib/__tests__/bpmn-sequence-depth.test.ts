import { describe, expect, it } from "vitest";
import { computeForwardSequenceDepths } from "../bpmn-sequence-depth";

describe("computeForwardSequenceDepths", () => {
  it("places a sequence_flow target to the right of its incoming source", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_early_target", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "decision_later_source", created_at: "2026-05-26T00:10:00.000Z" },
      ],
      [
        {
          source: "decision_later_source",
          target: "action_early_target",
          synapse_type: "sequence_flow",
        },
      ],
    );

    expect(depths.get("action_early_target")).toBeGreaterThan(
      depths.get("decision_later_source") ?? 0,
    );
  });

  it("keeps ordinary incoming edges forward when a later node loops back", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "decision_route", created_at: "2026-05-26T00:07:00.000Z" },
        { id: "action_checkout", created_at: "2026-05-26T00:15:00.000Z" },
      ],
      [
        { source: "decision_route", target: "action_checkout", synapse_type: "sequence_flow" },
        { source: "action_checkout", target: "decision_route", synapse_type: "sequence_flow" },
      ],
    );

    expect(depths.get("action_checkout")).toBeGreaterThan(depths.get("decision_route") ?? 0);
  });

  it("ignores association synapses when computing BPMN columns", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "rule_guard", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "action_pay", created_at: "2026-05-26T00:01:00.000Z" },
      ],
      [{ source: "action_pay", target: "rule_guard", synapse_type: "gated_by" }],
    );

    expect(depths.get("action_pay")).toBe(0);
    expect(depths.get("rule_guard")).toBe(0);
  });
});
