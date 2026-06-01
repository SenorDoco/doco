import { describe, expect, it } from "vitest";
import {
  RELATION_KINDS,
  unsupportedNodeJsonEdgeKeyError,
} from "../graph-authoring-contract.server";

describe("graph authoring contract", () => {
  it("marks every relation kind as edge-backed", () => {
    for (const spec of Object.values(RELATION_KINDS)) {
      expect(spec.storage, spec.kind).toBe("edge");
    }
  });

  it("rejects graph-link keys on create bodies", () => {
    expect(
      String(unsupportedNodeJsonEdgeKeyError("reference", { target_ref: "action_01" })),
    ).toMatch(/target_ref/);
    expect(String(unsupportedNodeJsonEdgeKeyError("eval", { target_ref: "action_01" }))).toMatch(
      /target_ref/,
    );
    expect(
      String(unsupportedNodeJsonEdgeKeyError("decision", { sequence_to: ["action_01"] })),
    ).toMatch(/sequence_to/);
    expect(
      String(unsupportedNodeJsonEdgeKeyError("decision", { implemented_by: ["reference_01"] })),
    ).toMatch(/implemented_by/);
  });

  it("rejects graph-link keys on create bodies even when the entity never owned the key", () => {
    const err = unsupportedNodeJsonEdgeKeyError("decision", { target_ref: "action_01" });
    expect(err).toMatch(/target_ref/);
    expect(err).toMatch(/edge/);
  });

  it("ignores absent or null graph-link keys", () => {
    expect(unsupportedNodeJsonEdgeKeyError("decision", {})).toBeNull();
    expect(unsupportedNodeJsonEdgeKeyError("decision", { target_ref: null })).toBeNull();
    expect(unsupportedNodeJsonEdgeKeyError("decision", { target_ref: undefined })).toBeNull();
  });

  it("exposes supports so changesets and the authoring-contract know about implementation links", () => {
    const spec = RELATION_KINDS.supports;
    expect(spec).toBeDefined();
    expect(spec).toMatchObject({
      kind: "supports",
      cardinality: "many",
    });
  });
});
