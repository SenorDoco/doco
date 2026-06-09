import { describe, expect, it } from "vitest";
import {
  processCameraFitTarget,
  processExpansionFitNodeId,
  processFocusFlowNodeId,
  processPoolFitNodeIds,
} from "../process-focus-fit";

describe("processPoolFitNodeIds", () => {
  const laneFlowNodeId = (id: string) => `lane:${id}`;
  const lanes = [
    { id: "poolA::talent", pool_id: "poolA" },
    { id: "poolA::torre", pool_id: "poolA" },
    { id: "poolB::ops", pool_id: "poolB" },
  ];
  const rendered = new Set([
    "pool-header:poolA",
    "lane:poolA::talent",
    "lane:poolA::torre",
    "pool-header:poolB",
    "lane:poolB::ops",
  ]);

  it("returns null for a non-pool target, keeping single-node zoom", () => {
    expect(processPoolFitNodeIds("action_123", lanes, laneFlowNodeId, rendered)).toBeNull();
  });

  it("fits the pool header plus every lane in that pool", () => {
    expect(processPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, rendered)).toEqual([
      "pool-header:poolA",
      "lane:poolA::talent",
      "lane:poolA::torre",
    ]);
  });

  it("excludes lanes that belong to other pools", () => {
    expect(
      processPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, rendered),
    ).not.toContain("lane:poolB::ops");
  });

  it("drops fit targets that are not currently rendered", () => {
    const partial = new Set(["pool-header:poolA", "lane:poolA::talent"]);
    expect(processPoolFitNodeIds("pool-header:poolA", lanes, laneFlowNodeId, partial)).toEqual([
      "pool-header:poolA",
      "lane:poolA::talent",
    ]);
  });
});

describe("processFocusFlowNodeId", () => {
  const poolIdByIntentId = new Map([
    ["intent_a", "pool:intent_a"],
    ["intent_b", "pool:intent_b"],
  ]);
  const rendered = new Set(["pool-header:pool:intent_a", "action_99"]);

  it("frames the whole pool for an Intent target (its header, not an entry step)", () => {
    expect(processFocusFlowNodeId("intent_a", poolIdByIntentId, rendered)).toBe(
      "pool-header:pool:intent_a",
    );
  });

  it("frames the node itself for a non-Intent target", () => {
    expect(processFocusFlowNodeId("action_99", poolIdByIntentId, rendered)).toBe("action_99");
  });

  it("returns null when neither the Intent's pool header nor the node is rendered", () => {
    expect(processFocusFlowNodeId("intent_b", poolIdByIntentId, rendered)).toBeNull();
    expect(processFocusFlowNodeId("decision_x", poolIdByIntentId, rendered)).toBeNull();
  });
});

describe("processExpansionFitNodeId", () => {
  const poolIdByProcessId = new Map([
    ["action_parent", "pool:action_parent"],
    ["action_sub", "pool:action_sub"],
  ]);
  const rendered = new Set(["pool-header:pool:action_sub", "lane:pool:action_sub::ops"]);

  it("frames the freshly expanded process's pool header", () => {
    expect(processExpansionFitNodeId("action_sub", poolIdByProcessId, rendered)).toBe(
      "pool-header:pool:action_sub",
    );
  });

  it("returns null when nothing is expanded, leaving the camera put", () => {
    expect(processExpansionFitNodeId(null, poolIdByProcessId, rendered)).toBeNull();
  });

  it("returns null until the expanded pool's header has actually rendered", () => {
    expect(processExpansionFitNodeId("action_sub", poolIdByProcessId, new Set())).toBeNull();
  });

  it("returns null for a process that heads no pool", () => {
    expect(processExpansionFitNodeId("action_ghost", poolIdByProcessId, rendered)).toBeNull();
  });
});

describe("processCameraFitTarget — re-fits on every navigation, not just the first", () => {
  const HOME = "pool-header:pool:top-level";
  const POOL_A = "pool-header:pool:action_a";

  // Stand-in for the one camera effect: fit whenever the target key changes,
  // and only then. This is exactly what the effect does with `lastFitKeyRef`.
  function runSequence(states: Parameters<typeof processCameraFitTarget>[0][]): string[] {
    let lastKey: string | null = null;
    const fired: string[] = [];
    for (const state of states) {
      const fit = processCameraFitTarget(state);
      if (!fit || fit.key === lastKey) {
        fired.push("skip");
        continue;
      }
      lastKey = fit.key;
      fired.push(fit.target ?? "fit-all");
    }
    return fired;
  }

  const home = {
    homeMode: true,
    homePoolHeaderId: HOME,
    expandedPoolHeaderId: null,
    focusFlowNodeId: null,
    urlFocused: false,
    fitResetKey: "v1",
  };
  const drillA = {
    homeMode: false,
    homePoolHeaderId: HOME,
    expandedPoolHeaderId: POOL_A,
    focusFlowNodeId: POOL_A,
    urlFocused: false,
    fitResetKey: "v1",
  };

  it("re-fits the overview when Home is clicked after a drill-in", () => {
    // The reported bug: Home rendered the top-level pool but never re-framed it.
    expect(runSequence([home, drillA, home])).toEqual([HOME, POOL_A, HOME]);
  });

  it("re-fits a process opened a second time", () => {
    // The reported bug: revisiting an already-seen process left the camera put.
    expect(runSequence([home, drillA, home, drillA])).toEqual([HOME, POOL_A, HOME, POOL_A]);
  });

  it("does not re-fit on a plain re-render with an unchanged target (no camera yank)", () => {
    expect(runSequence([drillA, drillA, drillA])).toEqual([POOL_A, "skip", "skip"]);
  });

  it("frames a focused node when nothing is drilled in", () => {
    expect(
      processCameraFitTarget({
        homeMode: false,
        homePoolHeaderId: HOME,
        expandedPoolHeaderId: null,
        focusFlowNodeId: "action_x",
        urlFocused: true,
        fitResetKey: "v1",
      }),
    ).toEqual({ key: "action_x", target: "action_x" });
  });

  it("lets a drill-in win over the URL focus (View subprocess off a focused parent)", () => {
    expect(
      processCameraFitTarget({
        homeMode: false,
        homePoolHeaderId: HOME,
        expandedPoolHeaderId: POOL_A,
        focusFlowNodeId: "pool-header:pool:action_parent",
        urlFocused: true,
        fitResetKey: "v1",
      }),
    ).toEqual({ key: POOL_A, target: POOL_A });
  });

  it("frames the whole canvas for a home with no top-level pool", () => {
    expect(
      processCameraFitTarget({
        homeMode: true,
        homePoolHeaderId: null,
        expandedPoolHeaderId: null,
        focusFlowNodeId: null,
        urlFocused: false,
        fitResetKey: "v1",
      }),
    ).toEqual({ key: "home:all|reset:v1", target: null });
  });

  it("returns null when there is nothing laid out to frame yet", () => {
    expect(
      processCameraFitTarget({
        homeMode: false,
        homePoolHeaderId: HOME,
        expandedPoolHeaderId: null,
        focusFlowNodeId: null,
        urlFocused: false,
        fitResetKey: "v1",
      }),
    ).toBeNull();
  });

  it("re-fits the cold-start view on a revalidation / filter change while unfocused", () => {
    // #1214: a revalidation or lifecycle-filter change (fitResetKey changes)
    // re-frames the current view even though the navigation target is the same.
    const before = { ...drillA, fitResetKey: "v1" };
    const after = { ...drillA, fitResetKey: "v2" };
    expect(runSequence([before, after])).toEqual([POOL_A, POOL_A]);
  });

  it("does NOT reset on a revalidation while a URL/agent focus holds the camera", () => {
    // #1214: focusing keeps its framing — fitResetKey must not re-fit then.
    const focused = {
      homeMode: false,
      homePoolHeaderId: HOME,
      expandedPoolHeaderId: null,
      focusFlowNodeId: "action_x",
      urlFocused: true,
      fitResetKey: "v1",
    };
    expect(runSequence([focused, { ...focused, fitResetKey: "v2" }])).toEqual(["action_x", "skip"]);
  });
});
