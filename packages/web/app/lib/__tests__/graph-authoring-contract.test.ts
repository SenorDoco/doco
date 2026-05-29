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

  it("exposes implemented_by so changesets and the authoring-contract know about it", () => {
    const spec = RELATION_KINDS.implemented_by;
    expect(spec).toBeDefined();
    expect(spec).toMatchObject({
      kind: "implemented_by",
      field: "implemented_by",
      cardinality: "many",
    });
    // No `owners` clause: any neuron can be implemented by code refs.
    // Decisions/ADRs are shipped by PRs; BPMN Actions are implemented at
    // code locations; Evals can be implemented by test files. Same edge,
    // different reading per owner type — keep the surface unconstrained.
    expect(spec.owners).toBeUndefined();
  });

  it("allows implemented_by on any owner type (decision, action, intent, eval)", () => {
    for (const owner of ["decision", "action", "intent", "eval"]) {
      expect(unsupportedRelationFieldError(owner, { implemented_by: ["reference_01"] })).toBeNull();
    }
  });
});
