import { describe, expect, it } from "vitest";
import type { ProcessPool } from "../process-perspective.server";
import { topLevelProcessPools } from "../process-top-level-processes";

function pool(
  processId: string | null,
  opts: { topLevel?: boolean; label?: string } = {},
): ProcessPool {
  return {
    id: processId ? `pool:${processId}` : "pool:unassigned",
    process_id: processId,
    label: opts.label ?? processId ?? "Unassigned",
    lifecycle: processId ? "active" : null,
    ...(opts.topLevel ? { top_level_process: true } : {}),
  };
}

describe("topLevelProcessPools", () => {
  it("keeps only the Actions the author marked top_level_process", () => {
    // `root_a` and `root_b` are flagged top-level processes; `sub` is a
    // process pool that no one flagged (a sub-process drilled from elsewhere),
    // so it is NOT part of the home directory.
    const pools = [
      pool("root_a", { topLevel: true }),
      pool("root_b", { topLevel: true }),
      pool("sub"),
    ];
    expect(topLevelProcessPools(pools).map((p) => p.process_id)).toEqual(["root_a", "root_b"]);
  });

  it("drops a parentless Action that is not flagged — not every orphan is top-level", () => {
    // The previous structural rule surfaced EVERY parentless Action (drafting
    // sketches, orphans, steps missing their `has_parent` link). Only an Action
    // the author explicitly marks `top_level_process` is "considered top-level".
    const pools = [pool("real", { topLevel: true }), pool("unlinked_draft")];
    expect(topLevelProcessPools(pools).map((p) => p.process_id)).toEqual(["real"]);
  });

  it("excludes the Unassigned pool (it is never a flagged process)", () => {
    const pools = [pool("root_a", { topLevel: true }), pool(null)];
    expect(topLevelProcessPools(pools).map((p) => p.process_id)).toEqual(["root_a"]);
  });

  it("preserves the incoming pool order", () => {
    const pools = [
      pool("c", { topLevel: true }),
      pool("a", { topLevel: true }),
      pool("b", { topLevel: true }),
    ];
    expect(topLevelProcessPools(pools).map((p) => p.process_id)).toEqual(["c", "a", "b"]);
  });
});
