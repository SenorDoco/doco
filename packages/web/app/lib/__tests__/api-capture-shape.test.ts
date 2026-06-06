import { describe, expect, it } from "vitest";
import { buildEntityGetResponse } from "../api-capture-shape";

// The READ side exposes the canonical row shape — `{prose, extra}` — for
// every node type. There is no type-named key. A policy carries its structured
// fields in `data` (no `prose`/`extra`).

describe("buildEntityGetResponse — expose the canonical row shape on read", () => {
  it("returns prose + extra for a node, with no type-named key", () => {
    const res = buildEntityGetResponse({
      id: "reference_1",
      entity_type: "reference",
      doco_id: "doco_1",
      lifecycle: "active",
      data: { prose: "ACME PR #1" },
      extra: { ref_type: "url", locator: "https://x", pr_body: "…" },
    });
    expect(res.prose).toBe("ACME PR #1");
    expect(res).not.toHaveProperty("reference"); // no legacy type-named key
    expect(res.extra).toEqual({ ref_type: "url", locator: "https://x", pr_body: "…" });
  });

  it("defaults extra to {} and prose to '' when absent", () => {
    const res = buildEntityGetResponse({
      id: "intent_1",
      entity_type: "intent",
      doco_id: "doco_1",
      data: {},
    });
    expect(res.prose).toBe("");
    expect(res.extra).toEqual({});
  });

  it("does not add prose/extra for a policy row", () => {
    const res = buildEntityGetResponse({
      id: "policy_1",
      entity_type: "policy",
      doco_id: "doco_1",
      data: { kind: "suggestion" },
    });
    expect(res).not.toHaveProperty("prose");
    expect(res).not.toHaveProperty("extra");
    expect(res.data).toEqual({ kind: "suggestion" });
  });
});
