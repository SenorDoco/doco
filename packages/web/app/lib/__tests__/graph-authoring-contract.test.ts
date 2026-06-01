import { describe, expect, it } from "vitest";
import { RELATION_KINDS, unsupportedRelationFieldError } from "../graph-authoring-contract.server";

const CANONICAL_RELATION_KINDS = [
  "flows_to",
  "supports",
  "constrained_by",
  "attributed_to",
  "has_parent",
  "derived_from",
  "replaces",
  "relates_to",
] as const;

describe("unsupportedRelationFieldError", () => {
  it("exposes only the canonical relation families", () => {
    expect(Object.keys(RELATION_KINDS).sort()).toEqual([...CANONICAL_RELATION_KINDS].sort());
  });

  it("marks every relation kind as edge-backed", () => {
    for (const spec of Object.values(RELATION_KINDS)) {
      expect(spec.storage, spec.kind).toBe("edge");
    }
  });

  it("allows target_ref authoring input on the tests-relation owners", () => {
    expect(unsupportedRelationFieldError("reference", { target_ref: "action_01" })).toBeNull();
    expect(unsupportedRelationFieldError("eval", { target_ref: "action_01" })).toBeNull();
  });

  it("rejects target_ref on an entity that does not own the tests relation", () => {
    const err = unsupportedRelationFieldError("decision", { target_ref: "action_01" });
    expect(err).toMatch(/target_ref/);
    expect(err).toMatch(/eval or reference/);
    expect(err).toMatch(/decision/);
  });

  it("ignores absent or null relation fields", () => {
    expect(unsupportedRelationFieldError("decision", {})).toBeNull();
    expect(unsupportedRelationFieldError("decision", { target_ref: null })).toBeNull();
    expect(unsupportedRelationFieldError("decision", { target_ref: undefined })).toBeNull();
  });

  it("allows sequence_to authoring input so capture can materialize flows_to edges", () => {
    expect(RELATION_KINDS.flows_to.storage).toBe("edge");
    expect(unsupportedRelationFieldError("decision", { sequence_to: ["action_01"] })).toBeNull();
  });

  it("allows preceded_by authoring input as flows_to role sugar", () => {
    expect(RELATION_KINDS.flows_to.kind).toBe("flows_to");
    expect(unsupportedRelationFieldError("action", { preceded_by: ["action_01"] })).toBeNull();
  });

  it("keeps eval and reference as the target_ref authoring owners", () => {
    expect(unsupportedRelationFieldError("reference", { target_ref: "action_01" })).toBeNull();
    expect(unsupportedRelationFieldError("eval", { target_ref: "action_01" })).toBeNull();
  });

  it("folds implemented_by into the broad supports relation family", () => {
    const spec = RELATION_KINDS.supports;
    expect(spec).toBeDefined();
    expect(spec).toMatchObject({
      kind: "supports",
      field: "supports",
      cardinality: "many",
    });
    // No `owners` clause: any node can be implemented by code refs.
    // Decisions/ADRs are shipped by PRs; BPMN Actions are implemented at
    // code locations; Evals can be implemented by test files. Same edge,
    // different reading per owner type — keep the surface unconstrained.
    expect(spec.owners).toBeUndefined();
  });

  it("allows implemented_by authoring input for any owner type", () => {
    for (const owner of ["decision", "action", "intent", "eval"]) {
      expect(unsupportedRelationFieldError(owner, { implemented_by: ["reference_01"] })).toBeNull();
    }
  });
});
