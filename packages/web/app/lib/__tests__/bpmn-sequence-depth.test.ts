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
          edge_type: "sequence_flow",
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
        { source: "decision_route", target: "action_checkout", edge_type: "sequence_flow" },
        { source: "action_checkout", target: "decision_route", edge_type: "sequence_flow" },
      ],
    );

    expect(depths.get("action_checkout")).toBeGreaterThan(depths.get("decision_route") ?? 0);
  });

  it("anchors a loop member beside its deep gateway instead of column 0", () => {
    // start -> mid -> gateway is the main chain (gateway is deep). The
    // loading step only connects to the gateway, both ways (a loop), and
    // was authored before the gateway — so the gateway->loading edge is
    // the demoted loopback, leaving loading with no surviving predecessor.
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_start", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "action_mid", created_at: "2026-05-26T00:01:00.000Z" },
        { id: "action_loading", created_at: "2026-05-26T00:02:00.000Z" },
        { id: "decision_gateway", created_at: "2026-05-26T00:09:00.000Z" },
      ],
      [
        { source: "action_start", target: "action_mid", edge_type: "sequence_flow" },
        { source: "action_mid", target: "decision_gateway", edge_type: "sequence_flow" },
        { source: "action_loading", target: "decision_gateway", edge_type: "sequence_flow" },
        // loopback (demoted): gateway routes back to the loading step
        { source: "decision_gateway", target: "action_loading", edge_type: "sequence_flow" },
      ],
    );

    const gateway = depths.get("decision_gateway") ?? 0;
    const loading = depths.get("action_loading") ?? 0;
    expect(gateway).toBeGreaterThanOrEqual(2); // deep via the main chain
    // The loading step sits one column left of the gateway, not at 0.
    expect(loading).toBe(gateway - 1);
  });

  it("leaves a genuine flow source (no inbound edge) at column 0", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_root", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "action_next", created_at: "2026-05-26T00:05:00.000Z" },
      ],
      [{ source: "action_root", target: "action_next", edge_type: "sequence_flow" }],
    );
    expect(depths.get("action_root")).toBe(0);
    expect(depths.get("action_next")).toBe(1);
  });

  it("ignores association edges when computing BPMN columns", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "rule_guard", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "action_pay", created_at: "2026-05-26T00:01:00.000Z" },
      ],
      [{ source: "action_pay", target: "rule_guard", edge_type: "gated_by" }],
    );

    expect(depths.get("action_pay")).toBe(0);
    expect(depths.get("rule_guard")).toBe(0);
  });
});
