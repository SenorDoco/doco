import { describe, expect, it, vi } from "vitest";
import {
  DOCO_API_TOOL,
  runDocoApiToolRequest,
  truncateDocoApiToolResultEnvelope,
} from "../doco-api-tool.server";

describe("doco-api-tool.server", () => {
  it("exports the shared doco_api tool contract", () => {
    expect(DOCO_API_TOOL.name).toBe("doco_api");
    expect(DOCO_API_TOOL.input_schema.required).toEqual(["method", "path"]);
  });

  it("refuses paths outside Doco's relative API surface", async () => {
    const execute = vi.fn();

    const result = await runDocoApiToolRequest({
      toolUseId: "toolu_1",
      input: { method: "GET", path: "https://example.com/api" },
      execute,
    });

    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      is_error: true,
    });
  });

  it("wraps executor responses in Anthropic tool_result blocks", async () => {
    const result = await runDocoApiToolRequest({
      toolUseId: "toolu_1",
      input: { method: "GET", path: "/api/v1/docos.json" },
      execute: async () => ({
        status: 200,
        ok: true,
        body: { docos: [{ qualified_handle: "doco/doco-bpms" }] },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.preview).toContain("GET /api/v1/docos.json -> 200");
    expect(result.result.content).toContain("doco/doco-bpms");
  });

  it("trims list-shaped tool results before raw truncation", () => {
    const content = truncateDocoApiToolResultEnvelope(
      {
        status: 200,
        ok: true,
        body: {
          count: 100,
          items: Array.from({ length: 100 }, (_, i) => ({
            id: `item_${i}`,
            text: "x".repeat(200),
          })),
        },
      },
      900,
    );

    expect(content).toContain("truncated");
    expect(content).toContain("kept_items");
    expect(content.length).toBeLessThanOrEqual(900);
  });
});
