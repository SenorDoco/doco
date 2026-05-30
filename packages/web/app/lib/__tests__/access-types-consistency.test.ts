import { EDGE_TYPES } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { RELATION_KINDS } from "../graph-authoring-contract.server";

// The shared access layer enumerates EDGE_TYPES so the per-type write
// gate can reference relation kinds without importing the web-only
// RELATION_KINDS registry. This test keeps the two in lockstep — adding a
// relation kind without adding it to EDGE_TYPES (or vice-versa) fails
// here rather than silently leaving a edge type un-gateable.
describe("EDGE_TYPES ⇄ RELATION_KINDS consistency", () => {
  it("covers exactly the RELATION_KINDS keys", () => {
    expect([...EDGE_TYPES].sort()).toEqual(Object.keys(RELATION_KINDS).sort());
  });

  it("every RELATION_KINDS entry's kind matches its key and is a edge type", () => {
    const edgeSet = new Set<string>(EDGE_TYPES);
    for (const [key, spec] of Object.entries(RELATION_KINDS)) {
      expect(spec.kind).toBe(key);
      expect(edgeSet.has(key)).toBe(true);
    }
  });
});
