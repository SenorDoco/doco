import { describe, expect, it } from "vitest";
import {
  PERSPECTIVE_CONTRACTS,
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

  it("keeps the glossary contract focused on term entries and separates aliases from replacements", () => {
    const glossary = PERSPECTIVE_CONTRACTS.glossary;
    expect(glossary.node_types).toEqual(["decision", "rule", "reference", "eval"]);
    expect(glossary.node_types).not.toContain("intent");

    const alternativesConstraint = glossary.constraints.find((constraint) =>
      /`alternatives`/i.test(constraint),
    );
    expect(alternativesConstraint).toMatch(/aliases/i);
    expect(alternativesConstraint).toMatch(/rejected labels/i);
    expect(alternativesConstraint).not.toMatch(/deprecated|historical/i);

    expect(glossary.constraints.join("\n")).toMatch(/deprecated terms at their replacement/i);
    expect(glossary.constraints.join("\n")).toMatch(/`replaces`/i);

    // Source citation rides the `derived_from` edge (matches the template).
    expect(glossary.constraints.join("\n")).toMatch(/`derived_from`/);
    // The deliberate two-stage stance: canonical (`active`) or deprecated
    // (`retired`) — no draft/queue stage for a glossary term.
    expect(glossary.constraints.join("\n")).toMatch(/no draft\/queue stage/i);
  });

  it("publishes the edge families WITHOUT role examples (edge `role` is gone)", () => {
    // An edge's meaning now comes from its type + endpoint node types, never a
    // `props.role` tag, so the authoring contract no longer publishes
    // `role_examples` for any family — and the description carries the meaning.
    for (const spec of Object.values(RELATION_KINDS)) {
      expect((spec as { role_examples?: unknown }).role_examples).toBeUndefined();
    }
    expect(RELATION_KINDS.supports?.description).toMatch(/endpoint node types|serves|tests/i);
    expect(RELATION_KINDS.attributed_to?.description).toMatch(/Principal/i);
    // No relation advertises a `role` prop either.
    for (const spec of Object.values(RELATION_KINDS)) {
      expect(spec.acceptsProps ?? []).not.toContain("role");
    }
  });
});
