import { describe, expect, it } from "vitest";
import { RELATION_KINDS, unsupportedRelationFieldError } from "../graph-authoring-contract.server";

describe("unsupportedRelationFieldError", () => {
  it("rejects target_ref on an entity that does not own the tests relation", () => {
    const err = unsupportedRelationFieldError("decision", { target_ref: "action_01" });
    expect(err).toMatch(/target_ref/);
    expect(err).toMatch(/eval or reference/);
    expect(err).toMatch(/decision/);
  });

  it("allows target_ref on reference and eval", () => {
    expect(unsupportedRelationFieldError("reference", { target_ref: "action_01" })).toBeNull();
    expect(unsupportedRelationFieldError("eval", { target_ref: "action_01" })).toBeNull();
  });

  it("ignores absent or null relation fields", () => {
    expect(unsupportedRelationFieldError("decision", {})).toBeNull();
    expect(unsupportedRelationFieldError("decision", { target_ref: null })).toBeNull();
    expect(unsupportedRelationFieldError("decision", { target_ref: undefined })).toBeNull();
  });

  it("does not gate relations without a declared owners set", () => {
    // sequence_to has no `owners`, so it must not be rejected anywhere.
    expect(RELATION_KINDS.sequence_flow.owners).toBeUndefined();
    expect(unsupportedRelationFieldError("decision", { sequence_to: ["action_01"] })).toBeNull();
  });

  it("declares eval and reference as the tests-relation owners", () => {
    expect(RELATION_KINDS.tests.owners).toEqual(["eval", "reference"]);
  });
});
