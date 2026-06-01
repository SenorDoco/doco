import { describe, expect, it } from "vitest";
import { subprocessTargetIntents } from "../bpmn-subprocess";

const rendered = (...ids: string[]) => new Set(ids);

describe("subprocessTargetIntents", () => {
  it("returns the served Intents beyond the Action's own pool", () => {
    expect(
      subprocessTargetIntents(
        {
          entity_type: "action",
          pool_id: "pool:intent_home",
          served_intent_ids: ["intent_home", "intent_sub"],
        },
        rendered("intent_home", "intent_sub"),
      ),
    ).toEqual(["intent_sub"]);
  });

  it("excludes the home Intent even when it is listed first or last", () => {
    expect(
      subprocessTargetIntents(
        { entity_type: "action", pool_id: "pool:intent_home", served_intent_ids: ["intent_home"] },
        rendered("intent_home"),
      ),
    ).toEqual([]);
  });

  it("drops sub-process Intents whose pool is not rendered on the canvas", () => {
    expect(
      subprocessTargetIntents(
        {
          entity_type: "action",
          pool_id: "pool:intent_home",
          served_intent_ids: ["intent_home", "intent_hidden"],
        },
        rendered("intent_home"), // intent_hidden has no pool
      ),
    ).toEqual([]);
  });

  it("preserves served Intent order and de-duplicates", () => {
    expect(
      subprocessTargetIntents(
        {
          entity_type: "action",
          pool_id: "pool:intent_home",
          served_intent_ids: ["intent_b", "intent_home", "intent_a", "intent_b"],
        },
        rendered("intent_home", "intent_a", "intent_b"),
      ),
    ).toEqual(["intent_b", "intent_a"]);
  });

  it("only marks Actions — gateways and other shapes never carry the '+' marker", () => {
    expect(
      subprocessTargetIntents(
        {
          entity_type: "decision",
          pool_id: "pool:intent_home",
          served_intent_ids: ["intent_home", "intent_sub"],
        },
        rendered("intent_home", "intent_sub"),
      ),
    ).toEqual([]);
  });

  it("returns nothing when the Action serves no Intents", () => {
    expect(
      subprocessTargetIntents(
        { entity_type: "action", pool_id: "pool:intent_home" },
        rendered("intent_home"),
      ),
    ).toEqual([]);
  });

  it("treats the Unassigned pool as having no home Intent to exclude", () => {
    // The Unassigned pool's id slices to "unassigned", which never
    // matches a real served Intent, so every rendered served Intent is
    // a genuine drill-down target.
    expect(
      subprocessTargetIntents(
        {
          entity_type: "action",
          pool_id: "pool:unassigned",
          served_intent_ids: ["intent_a", "intent_b"],
        },
        rendered("intent_a", "intent_b"),
      ),
    ).toEqual(["intent_a", "intent_b"]);
  });
});
