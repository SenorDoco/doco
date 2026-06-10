import { CATALOG_NODE_TYPES, NODE_CATALOG } from "@doco/shared";
import { describe, expect, it } from "vitest";
import {
  BESPOKE_CAPTURE_REGISTRY,
  CAPTURE_REGISTRY,
  CAPTURE_REGISTRY_BY_NODE_TYPE,
} from "../node-capture-registry.server";

// The set of node types is defined once in @doco/shared's NODE_CATALOG, but the
// authoring machinery (changeset, the generic capture route, the authoring
// contract) keys off the capture registry. If a catalog type isn't wired into
// that machinery it silently falls out of ALL of it — exactly how `principal`
// (capture: "bespoke") became uncreatable via changeset and absent from the
// contract, with nothing failing to flag it. This guard turns that drift into a
// CI failure: every catalog node type — generic OR bespoke — must be reachable
// by node_type. Add a type to NODE_CATALOG and you MUST wire its capture.
describe("node-type capture coverage", () => {
  it("every NODE_CATALOG type is wired into the capture machinery", () => {
    const covered = new Set(Object.keys(CAPTURE_REGISTRY_BY_NODE_TYPE));
    const missing = CATALOG_NODE_TYPES.filter((type) => !covered.has(type));
    expect(missing).toEqual([]);
  });

  it("each type is registered in the registry matching its declared capture mode", () => {
    const generic = new Set(Object.values(CAPTURE_REGISTRY).map((e) => e.entityType));
    const bespoke = new Set(Object.values(BESPOKE_CAPTURE_REGISTRY).map((e) => e.entityType));
    for (const type of CATALOG_NODE_TYPES) {
      const mode = NODE_CATALOG[type].capture;
      if (mode === "generic") {
        expect(generic.has(type), `${type} (generic) belongs in CAPTURE_REGISTRY`).toBe(true);
        expect(bespoke.has(type), `${type} (generic) must not be bespoke`).toBe(false);
      } else {
        expect(bespoke.has(type), `${type} (bespoke) belongs in BESPOKE_CAPTURE_REGISTRY`).toBe(
          true,
        );
        expect(generic.has(type), `${type} (bespoke) must not be generic`).toBe(false);
      }
    }
  });
});
