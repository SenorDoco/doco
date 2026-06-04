import { describe, expect, it } from "vitest";
import { buildEntityGetResponse, normalizeRawCaptureDraft } from "../api-capture-shape";

// Stage 2 of the node-shape slim-down (raw-schema phase, additive). The API
// learns to speak the row shape directly — `{prose, attributes}` — while the
// legacy type-named field keeps working. These pin the two pure pieces.

describe("normalizeRawCaptureDraft — accept the raw {prose, attributes} shape", () => {
  it("maps `prose` onto the type-named field the capture fn reads", () => {
    const draft = normalizeRawCaptureDraft(
      { prose: "Deploy the build", attributes: { verb: "deploy" } },
      "action",
    ) as Record<string, unknown>;
    expect(draft.action).toBe("Deploy the build");
    expect(draft.verb).toBe("deploy");
    // The wrapper keys are consumed, not left to leak into `data`.
    expect(draft).not.toHaveProperty("prose");
    expect(draft).not.toHaveProperty("attributes");
  });

  it("flattens attributes onto the draft without clobbering explicit top-level keys", () => {
    const draft = normalizeRawCaptureDraft(
      { prose: "x", verb: "top", attributes: { verb: "nested", target: "t" } },
      "action",
    ) as Record<string, unknown>;
    expect(draft.verb).toBe("top"); // explicit wins over attributes
    expect(draft.target).toBe("t");
  });

  it("leaves an explicit type-named field untouched when both are present", () => {
    const draft = normalizeRawCaptureDraft(
      { action: "Explicit", prose: "Ignored" },
      "action",
    ) as Record<string, unknown>;
    expect(draft.action).toBe("Explicit");
    expect(draft).not.toHaveProperty("prose");
  });

  it("ignores a non-object attributes value", () => {
    const draft = normalizeRawCaptureDraft({ prose: "p", attributes: "nope" }, "intent") as Record<
      string,
      unknown
    >;
    expect(draft.intent).toBe("p");
    expect(draft).not.toHaveProperty("attributes");
  });
});

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
