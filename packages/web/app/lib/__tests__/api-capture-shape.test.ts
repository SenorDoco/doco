import { describe, expect, it } from "vitest";
import { type NodeApiRow, nodeToApi } from "../api-capture-shape";

// The READ side exposes the honest node row — `prose` + `extra` + the promoted
// columns + audit. There is no `data` envelope and no type-named key.

function row(over: Partial<NodeApiRow> & Pick<NodeApiRow, "id" | "node_type">): NodeApiRow {
  return {
    doco_id: "doco_1",
    lifecycle: "active",
    prose: "",
    extra: {},
    kind: null,
    locator: null,
    proposer_id: null,
    created_at: null,
    updated_at: null,
    created_by: null,
    updated_by: null,
    ...over,
  };
}

describe("nodeToApi — the honest node row on read", () => {
  it("returns prose + extra + promoted columns, no `data` envelope, no type-named key", () => {
    const res = nodeToApi(
      row({
        id: "reference_1",
        node_type: "reference",
        prose: "ACME PR #1",
        locator: "https://x",
        extra: { pr_body: "…" },
      }),
    );
    expect(res.node_type).toBe("reference");
    expect(res.prose).toBe("ACME PR #1");
    expect(res.locator).toBe("https://x");
    expect(res.extra).toEqual({ pr_body: "…" });
    expect(res).not.toHaveProperty("data"); // no synthetic envelope
    expect(res).not.toHaveProperty("reference"); // no type-named key
  });

  it("omits absent promoted columns and defaults extra to {}", () => {
    const res = nodeToApi(row({ id: "intent_1", node_type: "intent" }));
    expect(res.prose).toBe("");
    expect(res.extra).toEqual({});
    expect(res).not.toHaveProperty("kind");
    expect(res).not.toHaveProperty("locator");
  });
});
