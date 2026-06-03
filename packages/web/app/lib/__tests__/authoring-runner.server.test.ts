/**
 * Pure (DB-free) unit tests for `resolveProbabilistic` — the step that hands a
 * pending probabilistic policy to the LLM judge and turns the verdict into a
 * final violation. No Postgres needed (the judge is mocked), so this runs in
 * CI, unlike the `*.integration.test.ts` sibling.
 *
 * Failure-mode contract under test: when the judge can't render a verdict
 * (API error, rate limit, missing key, exhausted credits → the judge returns
 * `null`), the policy could NOT be checked, so the capture FAILS CLOSED — the
 * violation is forced to `block` with an actionable error, regardless of the
 * policy's normal severity. Blocking loudly makes a judge outage obvious
 * instead of silently admitting an unvetted node.
 */
import type { LoadedPolicy, Violation } from "@doco/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProbabilistic } from "../authoring-runner.server";
import { judgeProbabilisticPredicate } from "../llm-judge.server";

vi.mock("../llm-judge.server", () => ({ judgeProbabilisticPredicate: vi.fn() }));
const mockedJudge = vi.mocked(judgeProbabilisticPredicate);

beforeEach(() => mockedJudge.mockReset());

function policy(id: string, on_violation: "block" | "warn" | "log"): LoadedPolicy {
  return {
    policy_id: id,
    kind: "probabilistic",
    predicate: { agent_instruction: `judge spec for ${id}` },
    on_violation,
  };
}

function pending(policyId: string, on_violation: "block" | "warn" | "log"): Violation {
  return {
    policy_id: policyId,
    kind: "probabilistic",
    on_violation,
    reason: "pending",
    pending_spec: `judge spec for ${policyId}`,
  };
}

const candidate = { id: "decision_01", node_type: "decision" as const };

describe("resolveProbabilistic — judge unavailable fails closed", () => {
  it("blocks with an actionable error when the judge is unavailable (originally block)", async () => {
    mockedJudge.mockResolvedValue(null);
    const out = await resolveProbabilistic(
      [pending("policy_block", "block")],
      [policy("policy_block", "block")],
      candidate,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.on_violation).toBe("block");
    expect(out[0]?.reason).toMatch(/could not be checked/i);
    // The error names the things an operator would check (key / rate limit /
    // credit balance) so the outage is easy to diagnose.
    expect(out[0]?.reason).toMatch(/credit balance|rate limit|unavailable/i);
  });

  it("escalates a warn policy to block when the judge is unavailable — any LLM failure blocks", async () => {
    mockedJudge.mockResolvedValue(null);
    const out = await resolveProbabilistic(
      [pending("policy_warn", "warn")],
      [policy("policy_warn", "warn")],
      candidate,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.on_violation).toBe("block");
  });

  it("escalates a log policy to block when the judge is unavailable", async () => {
    mockedJudge.mockResolvedValue(null);
    const out = await resolveProbabilistic(
      [pending("policy_log", "log")],
      [policy("policy_log", "log")],
      candidate,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.on_violation).toBe("block");
  });

  it("drops the violation when the judge passes", async () => {
    mockedJudge.mockResolvedValue({ ok: true });
    const out = await resolveProbabilistic(
      [pending("p", "warn")],
      [policy("p", "warn")],
      candidate,
    );
    expect(out).toEqual([]);
  });

  it("keeps the violation with the judge's reason when the judge fails it", async () => {
    mockedJudge.mockResolvedValue({ ok: false, reason: "missing rationale" });
    const out = await resolveProbabilistic(
      [pending("p", "block")],
      [policy("p", "block")],
      candidate,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.on_violation).toBe("block");
    expect(out[0]?.reason).toMatch(/missing rationale/);
  });

  it("passes deterministic violations through untouched (never calls the judge)", async () => {
    const deterministic: Violation = {
      policy_id: "det",
      kind: "deterministic",
      sub_kind: "requires_field",
      on_violation: "block",
      reason: "missing required field(s): `chosen`",
    };
    const out = await resolveProbabilistic([deterministic], [], candidate);
    expect(out).toEqual([deterministic]);
    expect(mockedJudge).not.toHaveBeenCalled();
  });
});
