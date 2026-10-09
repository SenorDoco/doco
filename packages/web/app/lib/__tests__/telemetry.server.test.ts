import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn({ query: mocks.query }),
}));

import { recordCaptureTiming } from "../telemetry.server";

describe("recordCaptureTiming", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  // capture_timings keeps whole milliseconds, and the phase timers measure
  // with performance.now(): on 2026-10-09 production logged "invalid input
  // syntax for type integer: 15.65…" and dropped the row.
  it("writes whole milliseconds, since the table's columns are integers", async () => {
    await recordCaptureTiming({
      doco_id: "doco_1",
      entity_type: "log",
      http_method: "POST",
      principal_id: "user_1",
      total_ms: 168.30522400001064,
      bag: {
        persist_ms: 15.653731999998854,
        authoring_ms: 1771.5297819999978,
        judge_ms: 0.4,
        judge_calls: 1,
        reindex_structural_ms: 2.5,
        reindex_load_ms: 3.49,
        reindex_load_entity_count: 12,
      },
      status_code: 201,
      user_agent: null,
      error: null,
    });
    const params: unknown[] = mocks.query.mock.calls[0][1];
    expect(params.slice(5, 13)).toEqual([168, 16, 1772, 0, 1, 3, 3, 12]);
  });
});
