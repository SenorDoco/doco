import { SYNAPSE_TYPES } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { RELATION_KINDS } from "../graph-authoring-contract.server";

// The shared access layer enumerates SYNAPSE_TYPES so the per-type write
// gate can reference relation kinds without importing the web-only
// RELATION_KINDS registry. This test keeps the two in lockstep — adding a
// relation kind without adding it to SYNAPSE_TYPES (or vice-versa) fails
// here rather than silently leaving a synapse type un-gateable.
describe("SYNAPSE_TYPES ⇄ RELATION_KINDS consistency", () => {
  it("covers exactly the RELATION_KINDS keys", () => {
    expect([...SYNAPSE_TYPES].sort()).toEqual(Object.keys(RELATION_KINDS).sort());
  });

  it("every RELATION_KINDS entry's kind matches its key and is a synapse type", () => {
    const synapseSet = new Set<string>(SYNAPSE_TYPES);
    for (const [key, spec] of Object.entries(RELATION_KINDS)) {
      expect(spec.kind).toBe(key);
      expect(synapseSet.has(key)).toBe(true);
    }
  });
});
