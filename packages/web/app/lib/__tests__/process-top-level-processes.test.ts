import { describe, expect, it } from "vitest";
import type { ProcessNode, ProcessPool } from "../process-perspective.server";
import { topLevelProcessPools } from "../process-top-level-processes";

function pool(processId: string | null, label = processId ?? "Unassigned"): ProcessPool {
  return {
    id: processId ? `pool:${processId}` : "pool:unassigned",
    process_id: processId,
    label,
    lifecycle: processId ? "active" : null,
  };
}

function member(id: string, poolProcessId: string, isProcess = false): ProcessNode {
  return {
    id,
    entity_type: "action",
    name: id,
    lifecycle: "active",
    created_at: null,
    href: null,
    shape: "task",
    laneId: `pool:${poolProcessId}::principal_x`,
    pool_id: `pool:${poolProcessId}`,
    ...(isProcess ? { is_process: true } : {}),
  };
}

describe("topLevelProcessPools", () => {
  it("keeps processes that are no one's sub-process", () => {
    // root_a and root_b are both top-level; `sub` is a process Action that is
    // a member of root_a (it has a parent), so its pool drops out of the list.
    const pools = [pool("root_a"), pool("root_b"), pool("sub")];
    const nodes = [member("sub", "root_a", true), member("leaf", "root_a")];
    expect(topLevelProcessPools(pools, nodes).map((p) => p.process_id)).toEqual([
      "root_a",
      "root_b",
    ]);
  });

  it("excludes the Unassigned pool (it has no process)", () => {
    const pools = [pool("root_a"), pool(null)];
    expect(topLevelProcessPools(pools, []).map((p) => p.process_id)).toEqual(["root_a"]);
  });

  it("a process that is also a member elsewhere is not top-level", () => {
    // `shared` owns its own members AND is a member of root (a sub-process
    // there). Being a member anywhere demotes it from the list.
    const pools = [pool("root"), pool("shared")];
    const nodes = [member("shared", "root", true), member("act_own", "shared")];
    expect(topLevelProcessPools(pools, nodes).map((p) => p.process_id)).toEqual(["root"]);
  });

  it("preserves the incoming pool order", () => {
    const pools = [pool("c"), pool("a"), pool("b")];
    expect(topLevelProcessPools(pools, []).map((p) => p.process_id)).toEqual(["c", "a", "b"]);
  });
});
