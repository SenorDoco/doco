import { describe, expect, it } from "vitest";
import { buildEntityGetResponse } from "../api-capture-shape";

// Node-shape slim-down (raw-schema phase). The READ side exposes the row shape
// directly — `{prose, attributes}` — alongside the legacy type-named field.
// (The write-side `normalizeRawCaptureDraft` translation shim is gone; the
// generic writer accepts `{prose, kind?, attributes}` natively — see
// capture-generic.server.test.ts.)

describe("buildEntityGetResponse — expose the row shape on read", () => {
  it("returns prose + attributes alongside the legacy type-named field for a node", () => {
    const res = buildEntityGetResponse(
      {
        id: "reference_1",
        entity_type: "reference",
        doco_id: "doco_1",
        lifecycle: "active",
        data: { reference: "ACME PR #1" },
        type_named_value: "ACME PR #1",
        attributes: { ref_type: "url", locator: "https://x", pr_body: "…" },
      },
      "reference",
    );
    expect(res.reference).toBe("ACME PR #1"); // legacy alias still present
    expect(res.prose).toBe("ACME PR #1");
    expect(res.attributes).toEqual({ ref_type: "url", locator: "https://x", pr_body: "…" });
  });

  it("defaults attributes to {} and prose to '' when absent", () => {
    const res = buildEntityGetResponse(
      { id: "intent_1", entity_type: "intent", doco_id: "doco_1", data: {} },
      "intent",
    );
    expect(res.prose).toBe("");
    expect(res.attributes).toEqual({});
  });

  it("does not add prose/attributes for a policy row", () => {
    const res = buildEntityGetResponse(
      {
        id: "policy_1",
        entity_type: "policy",
        doco_id: "doco_1",
        data: { kind: "suggestion" },
        body_md: "B",
      },
      "policy",
    );
    expect(res).not.toHaveProperty("prose");
    expect(res).not.toHaveProperty("attributes");
    expect(res.body_md).toBe("B");
  });
});
