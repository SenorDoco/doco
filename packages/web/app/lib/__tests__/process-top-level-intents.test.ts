import { describe, expect, it } from "vitest";
import type { ProcessNode, ProcessPool } from "../process-perspective.server";
import { topLevelIntentPools } from "../process-top-level-intents";

function pool(intentId: string | null, label = intentId ?? "Unassigned"): ProcessPool {
  return {
    id: intentId ? `pool:${intentId}` : "pool:unassigned",
    intent_id: intentId,
    label,
    lifecycle: intentId ? "active" : null,
  };
}

function action(id: string, poolIntentId: string, served: string[]): ProcessNode {
  return {
    id,
    entity_type: "action",
    name: id,
    lifecycle: "active",
    created_at: null,
    href: null,
    shape: "task",
    laneId: `pool:${poolIntentId}::principal_x`,
    pool_id: `pool:${poolIntentId}`,
    served_intent_ids: served,
  };
}

describe("topLevelIntentPools", () => {
  it("keeps Intents no Action invokes as a sub-process", () => {
    // root_a and root_b are both top-level; an Action in root_a serves the
    // child sub-process intent `sub`, which therefore drops out of the list.
    const pools = [pool("root_a"), pool("root_b"), pool("sub")];
    const nodes = [action("act1", "root_a", ["root_a", "sub"])];
    expect(topLevelIntentPools(pools, nodes).map((p) => p.intent_id)).toEqual(["root_a", "root_b"]);
  });

  it("excludes the Unassigned pool (it has no Intent)", () => {
    const pools = [pool("root_a"), pool(null)];
    expect(topLevelIntentPools(pools, []).map((p) => p.intent_id)).toEqual(["root_a"]);
  });

  it("an Intent that is both a process and a sub-process target is not top-level", () => {
    // `shared` owns its own Action (act_own) AND is invoked as a sub-process
    // by an Action in root. Being invoked anywhere demotes it from the list.
    const pools = [pool("root"), pool("shared")];
    const nodes = [
      action("act_own", "shared", ["shared"]),
      action("act_call", "root", ["root", "shared"]),
    ];
    expect(topLevelIntentPools(pools, nodes).map((p) => p.intent_id)).toEqual(["root"]);
  });

  it("only Actions invoke sub-processes — a Decision serving another Intent does not demote it", () => {
    const pools = [pool("root"), pool("other")];
    const nodes: ProcessNode[] = [
      {
        id: "dec1",
        entity_type: "decision",
        name: "dec1",
        lifecycle: "active",
        created_at: null,
        href: null,
        shape: "diamond",
        laneId: "pool:root::principal_x",
        pool_id: "pool:root",
        served_intent_ids: ["root", "other"],
      },
    ];
    expect(topLevelIntentPools(pools, nodes).map((p) => p.intent_id)).toEqual(["root", "other"]);
  });

  it("preserves the incoming pool order", () => {
    const pools = [pool("c"), pool("a"), pool("b")];
    expect(topLevelIntentPools(pools, []).map((p) => p.intent_id)).toEqual(["c", "a", "b"]);
  });
});
