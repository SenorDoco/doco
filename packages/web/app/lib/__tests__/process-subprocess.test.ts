import { describe, expect, it } from "vitest";
import { subprocessPoolId } from "../process-subprocess";

describe("subprocessPoolId", () => {
  it("returns the node's own pool id when it is a process Action", () => {
    expect(subprocessPoolId({ id: "action_x", entity_type: "action", is_process: true })).toBe(
      "pool:action_x",
    );
  });

  it("returns null for an ordinary (non-process) Action", () => {
    expect(subprocessPoolId({ id: "action_x", entity_type: "action" })).toBeNull();
    expect(
      subprocessPoolId({ id: "action_x", entity_type: "action", is_process: false }),
    ).toBeNull();
  });

  it("only marks Actions — gateways and milestones never carry the marker", () => {
    expect(
      subprocessPoolId({ id: "decision_x", entity_type: "decision", is_process: true }),
    ).toBeNull();
    expect(subprocessPoolId({ id: "state_x", entity_type: "state", is_process: true })).toBeNull();
  });
});
