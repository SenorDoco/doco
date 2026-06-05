import { describe, expect, it } from "vitest";
import { buildEntityGetResponse } from "../api-capture-shape";

// The READ side exposes the canonical row shape — `{prose, attributes}` — for
// every node type. There is no type-named key. Policies keep `body_md`.

describe("buildEntityGetResponse — expose the canonical row shape on read", () => {
  it("returns prose + attributes for a node, with no type-named key", () => {
    const res = buildEntityGetResponse({
      id: "reference_1",
      entity_type: "reference",
      doco_id: "doco_1",
      lifecycle: "active",
      data: { prose: "ACME PR #1" },
      attributes: { ref_type: "url", locator: "https://x", pr_body: "…" },
    });
    expect(res.prose).toBe("ACME PR #1");
    expect(res).not.toHaveProperty("reference"); // no legacy type-named key
    expect(res.attributes).toEqual({ ref_type: "url", locator: "https://x", pr_body: "…" });
  });

  it("defaults attributes to {} and prose to '' when absent", () => {
    const res = buildEntityGetResponse({
      id: "intent_1",
      entity_type: "intent",
      doco_id: "doco_1",
      data: {},
    });
    expect(res.prose).toBe("");
    expect(res.attributes).toEqual({});
  });

  it("does not add prose/attributes for a policy row", () => {
    const res = buildEntityGetResponse({
      id: "policy_1",
      entity_type: "policy",
      doco_id: "doco_1",
      data: { kind: "suggestion" },
      body_md: "B",
    });
    expect(res).not.toHaveProperty("prose");
    expect(res).not.toHaveProperty("attributes");
    expect(res.body_md).toBe("B");
  });
});
