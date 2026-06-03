import { describe, expect, it } from "vitest";

import {
  type ThreadUsageModelRow,
  aggregateThreadUsage,
  estimateTokenCostUsd,
} from "../agent-cost";

const zero = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

describe("estimateTokenCostUsd", () => {
  it("prices a million input/output tokens at the Sonnet published rate", () => {
    expect(
      estimateTokenCostUsd({ ...zero, input_tokens: 1_000_000 }, "claude-sonnet-4-6"),
    ).toBeCloseTo(3, 6);
    expect(
      estimateTokenCostUsd({ ...zero, output_tokens: 1_000_000 }, "claude-sonnet-4-6"),
    ).toBeCloseTo(15, 6);
  });

  it("prices cache read and cache write tokens", () => {
    const cost = estimateTokenCostUsd(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 2000,
        cache_creation_tokens: 100,
      },
      "claude-sonnet-4-6",
    );
    // 1000*3 + 500*15 + 2000*0.3 + 100*3.75, all /1e6
    expect(cost).toBeCloseTo(0.011475, 9);
  });

  it("uses Haiku and Opus rates when the model name matches", () => {
    expect(
      estimateTokenCostUsd({ ...zero, input_tokens: 1_000_000 }, "claude-haiku-4-5"),
    ).toBeCloseTo(0.8, 6);
    expect(
      estimateTokenCostUsd({ ...zero, output_tokens: 1_000_000 }, "claude-opus-4-8"),
    ).toBeCloseTo(75, 6);
  });

  it("falls back to Sonnet pricing for an unknown or empty model", () => {
    expect(estimateTokenCostUsd({ ...zero, input_tokens: 1_000_000 }, "")).toBeCloseTo(3, 6);
    expect(estimateTokenCostUsd({ ...zero, input_tokens: 1_000_000 }, "mystery-model")).toBeCloseTo(
      3,
      6,
    );
  });

  it("is zero for no usage", () => {
    expect(estimateTokenCostUsd(zero, "claude-sonnet-4-6")).toBe(0);
  });
});

describe("aggregateThreadUsage", () => {
  it("returns all-zero usage for an empty thread", () => {
    expect(aggregateThreadUsage([])).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turn_count: 0,
      estimated_cost_usd: 0,
    });
  });

  it("sums tokens and turns across a single model bucket and prices them", () => {
    const rows: ThreadUsageModelRow[] = [
      {
        model: "claude-sonnet-4-6",
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 2,
      },
    ];
    const usage = aggregateThreadUsage(rows);
    expect(usage.input_tokens).toBe(1000);
    expect(usage.output_tokens).toBe(500);
    expect(usage.turn_count).toBe(2);
    // 1000*3/1e6 + 500*15/1e6
    expect(usage.estimated_cost_usd).toBeCloseTo(0.0105, 9);
  });

  it("prices each model bucket with its own rate when a thread spans models", () => {
    const rows: ThreadUsageModelRow[] = [
      {
        model: "claude-sonnet-4-6",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 1,
      },
      {
        model: "claude-haiku-4-5",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 1,
      },
    ];
    const usage = aggregateThreadUsage(rows);
    expect(usage.input_tokens).toBe(2_000_000);
    expect(usage.turn_count).toBe(2);
    // Sonnet input (3) + Haiku input (0.8) — NOT both priced at one rate.
    expect(usage.estimated_cost_usd).toBeCloseTo(3.8, 6);
  });
});
