import { describe, expect, it } from "vitest";
import { computeForwardSequenceDepths } from "../process-sequence-depth";

describe("computeForwardSequenceDepths", () => {
  it("places a flows_to target to the right of its incoming source", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_early_target", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "decision_later_source", created_at: "2026-05-26T00:10:00.000Z" },
      ],
      [
        {
          source: "decision_later_source",
          target: "action_early_target",
          edge_type: "flows_to",
        },
      ],
    );

    expect(depths.get("action_early_target")).toBeGreaterThan(
      depths.get("decision_later_source") ?? 0,
    );
  });

  it("pins a marked entry point to column 0 even with an incoming flows_to", () => {
    // An entry point is the start of the flow. Even if another node flows into
    // it, it stays in the first column (and its target advances rightward).
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_upstream", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "state_start", created_at: "2026-05-26T00:05:00.000Z", entry_point: true },
        { id: "action_next", created_at: "2026-05-26T00:10:00.000Z" },
      ],
      [
        { source: "action_upstream", target: "state_start", edge_type: "flows_to" },
        { source: "state_start", target: "action_next", edge_type: "flows_to" },
      ],
    );
    expect(depths.get("state_start")).toBe(0);
    expect(depths.get("action_next") ?? 0).toBeGreaterThan(0);
  });

  it("keeps ordinary incoming edges forward when a later node loops back", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "decision_route", created_at: "2026-05-26T00:07:00.000Z" },
        { id: "action_checkout", created_at: "2026-05-26T00:15:00.000Z" },
      ],
      [
        { source: "decision_route", target: "action_checkout", edge_type: "flows_to" },
        { source: "action_checkout", target: "decision_route", edge_type: "flows_to" },
      ],
    );

    expect(depths.get("action_checkout")).toBeGreaterThan(depths.get("decision_route") ?? 0);
  });

  it("roots a loop at the gateway flow enters through, not its oldest member", () => {
    // start -> mid -> gateway is the main chain (gateway is deep). The loading
    // step only connects to the gateway, both ways (a loop). Flow enters the
    // loop at the gateway (via mid), so the gateway is the loop head: the
    // gateway->loading edge is the kept forward edge and loading->gateway is
    // the demoted loopback — the loading step it routes to sits to its RIGHT,
    // regardless of which of the two was authored first.
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_start", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "action_mid", created_at: "2026-05-26T00:01:00.000Z" },
        { id: "action_loading", created_at: "2026-05-26T00:02:00.000Z" },
        { id: "decision_gateway", created_at: "2026-05-26T00:09:00.000Z" },
      ],
      [
        { source: "action_start", target: "action_mid", edge_type: "flows_to" },
        { source: "action_mid", target: "decision_gateway", edge_type: "flows_to" },
        { source: "action_loading", target: "decision_gateway", edge_type: "flows_to" },
        // loopback (demoted): gateway routes back to the loading step
        { source: "decision_gateway", target: "action_loading", edge_type: "flows_to" },
      ],
    );

    const gateway = depths.get("decision_gateway") ?? 0;
    const loading = depths.get("action_loading") ?? 0;
    expect(gateway).toBeGreaterThanOrEqual(2); // deep via the main chain
    // The loading step the gateway routes to sits one column to its right.
    expect(loading).toBe(gateway + 1);
  });

  it("places a loop's mid step right of its entry even when authored first", () => {
    // A job-posting review loop: the user inputs the role name, an AI step
    // checks it for scam content, a gateway routes a flagged result to a
    // warning, and the warning loops back to the input. The AI step was
    // authored BEFORE the human input, so it is the cycle's earliest-created
    // member — but flow enters the loop at the input, so the input is the loop
    // head and the AI step must sit to its right, never parked in column 0.
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_open", created_at: "2026-06-08T00:00:00.000Z" },
        { id: "action_detect", created_at: "2026-06-08T00:01:00.000Z" },
        { id: "action_warn", created_at: "2026-06-08T00:02:00.000Z" },
        { id: "action_inputs", created_at: "2026-06-08T00:05:00.000Z" },
        { id: "decision_gate", created_at: "2026-06-08T00:06:00.000Z" },
      ],
      [
        { source: "action_open", target: "action_inputs", edge_type: "flows_to" },
        { source: "action_inputs", target: "action_detect", edge_type: "flows_to" },
        { source: "action_detect", target: "decision_gate", edge_type: "flows_to" },
        { source: "decision_gate", target: "action_warn", edge_type: "flows_to" },
        // loopback: the warning routes back to re-enter the input step
        { source: "action_warn", target: "action_inputs", edge_type: "flows_to" },
      ],
    );

    const inputs = depths.get("action_inputs") ?? 0;
    const detect = depths.get("action_detect") ?? 0;
    // The AI step follows the input it reads — to the right, never at column 0.
    expect(detect).toBeGreaterThan(0);
    expect(detect).toBe(inputs + 1);
  });

  it("leaves a genuine flow source (no inbound edge) at column 0", () => {
    const depths = computeForwardSequenceDepths(
      [
        { id: "action_root", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "action_next", created_at: "2026-05-26T00:05:00.000Z" },
      ],
      [{ source: "action_root", target: "action_next", edge_type: "flows_to" }],
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
      [{ source: "action_pay", target: "rule_guard", edge_type: "constrained_by" }],
    );

    expect(depths.get("action_pay")).toBe(0);
    expect(depths.get("rule_guard")).toBe(0);
  });
});
