import { describe, expect, it } from "vitest";
import type { ProcessLane, ProcessNode, ProcessPool } from "../process-perspective.server";
import { processReferences } from "../process-references";

function pool(overrides: Partial<ProcessPool> & Pick<ProcessPool, "id">): ProcessPool {
  return {
    intent_id: null,
    label: "Pool",
    lifecycle: null,
    ...overrides,
  };
}

function lane(overrides: Partial<ProcessLane> & Pick<ProcessLane, "id" | "kind">): ProcessLane {
  return {
    pool_id: "pool:intent_1",
    base_id: "principal_1",
    label: "Lane",
    lifecycle: null,
    ...overrides,
  };
}

function node(overrides: Partial<ProcessNode> & Pick<ProcessNode, "id">): ProcessNode {
  return {
    entity_type: "action",
    name: overrides.id,
    lifecycle: "active",
    created_at: null,
    href: null,
    shape: "task",
    laneId: "pool:intent_1::principal_1",
    pool_id: "pool:intent_1",
    ...overrides,
  };
}

const focal = (...ids: string[]): ReadonlySet<string> => new Set(ids);
const numbersById = (refs: { id: string; number: number }[]): Record<string, number> =>
  Object.fromEntries(refs.map((r) => [r.id, r.number]));

describe("processReferences", () => {
  it("numbers the focal Intent pool first, then each swimlane, then flow nodes in creation order", () => {
    const pools: ProcessPool[] = [
      pool({
        id: "pool:intent_1",
        intent_id: "intent_1",
        label: "Fulfill customer orders",
        lifecycle: "active",
      }),
    ];
    const lanes: ProcessLane[] = [
      lane({
        id: "pool:intent_1::principal_sales",
        base_id: "principal_sales",
        kind: "actor",
        label: "Sales",
        lifecycle: "active",
      }),
      lane({
        id: "pool:intent_1::principal_warehouse",
        base_id: "principal_warehouse",
        kind: "actor",
        label: "Warehouse",
        lifecycle: "drafting",
      }),
    ];
    // Deliberately out of creation order in the array — numbering sorts by
    // `created_at`, not array position, so "Pick" (created first) precedes
    // "Pack" regardless.
    const nodes: ProcessNode[] = [
      node({ id: "action_pack", name: "Pack items", created_at: "2024-01-02T00:00:00Z" }),
      node({ id: "action_pick", name: "Pick items", created_at: "2024-01-01T00:00:00Z" }),
    ];

    const refs = processReferences(pools, lanes, nodes, focal("pool:intent_1"), "demo");

    expect(refs.map((r) => `#${r.number} ${r.entity_type}:${r.label}`)).toEqual([
      "#1 intent:Fulfill customer orders",
      "#2 principal:Sales",
      "#3 principal:Warehouse",
      "#4 action:Pick items",
      "#5 action:Pack items",
    ]);
    // The Intent reference points at the Intent node and links to its page.
    expect(refs[0]).toMatchObject({
      id: "intent_1",
      entity_type: "intent",
      href: "/demo/intent/intent_1",
    });
    // Swimlanes key off the composite lane id (so the same Principal in two
    // pools stays distinct) and carry no href, matching the existing lane badge.
    expect(refs[1]).toMatchObject({ id: "pool:intent_1::principal_sales", href: null });
  });

  it("numbers only the focal Intent — never another intent's pool, lanes, or nodes", () => {
    const pools: ProcessPool[] = [
      pool({ id: "pool:intent_1", intent_id: "intent_1", label: "Focal", lifecycle: "active" }),
      pool({ id: "pool:intent_2", intent_id: "intent_2", label: "Neighbour", lifecycle: "active" }),
    ];
    const lanes: ProcessLane[] = [
      lane({ id: "pool:intent_1::p1", pool_id: "pool:intent_1", kind: "actor", label: "P1" }),
      lane({ id: "pool:intent_2::p2", pool_id: "pool:intent_2", kind: "actor", label: "P2" }),
    ];
    const nodes: ProcessNode[] = [
      node({ id: "focal_node", pool_id: "pool:intent_1", created_at: "2024-01-01T00:00:00Z" }),
      // A cross-intent neighbour drawn for context — it belongs to intent_2 and
      // earns its number only when intent_2 is the focus, never a borrowed one here.
      node({ id: "neighbour_node", pool_id: "pool:intent_2", created_at: "2024-01-01T00:00:00Z" }),
    ];

    const refs = processReferences(pools, lanes, nodes, focal("pool:intent_1"), "demo");

    expect(refs.map((r) => r.id)).toEqual(["intent_1", "pool:intent_1::p1", "focal_node"]);
  });

  it("keeps every number stable when a node is retired / hidden / lifecycle-filtered", () => {
    // Retiring, hiding, and lifecycle-filtering all leave the node in the
    // Intent's membership (the server keeps every lifecycle); only its
    // lifecycle flag or on-screen visibility changes. The numbering must not
    // move — the node keeps its #N, its badge simply stops rendering.
    const pools: ProcessPool[] = [
      pool({ id: "pool:intent_1", intent_id: "intent_1", label: "I", lifecycle: "active" }),
    ];
    const nodes: ProcessNode[] = [
      node({ id: "a", created_at: "2024-01-01T00:00:00Z" }),
      node({ id: "b", created_at: "2024-01-02T00:00:00Z" }),
      node({ id: "c", created_at: "2024-01-03T00:00:00Z" }),
    ];
    const before = processReferences(pools, [], nodes, focal("pool:intent_1"), "demo");

    const afterRetire = nodes.map((n) => (n.id === "b" ? { ...n, lifecycle: "retired" } : n));
    const after = processReferences(pools, [], afterRetire, focal("pool:intent_1"), "demo");

    expect(numbersById(after)).toEqual(numbersById(before));
    // b is still numbered — membership is unchanged, only its lifecycle flag is.
    expect(after.find((r) => r.id === "b")?.number).toBe(before.find((r) => r.id === "b")?.number);
  });

  it("gives a newly added node the next free number, leaving existing numbers put", () => {
    const pools: ProcessPool[] = [
      pool({ id: "pool:intent_1", intent_id: "intent_1", label: "I", lifecycle: "active" }),
    ];
    const existing: ProcessNode[] = [
      node({ id: "a", created_at: "2024-01-01T00:00:00Z" }),
      node({ id: "b", created_at: "2024-01-02T00:00:00Z" }),
    ];
    const before = processReferences(pools, [], existing, focal("pool:intent_1"), "demo");

    // A genuinely new node has the newest `created_at`, so it sorts last and
    // takes the next number; #1 intent, #2 a, #3 b are untouched.
    const withNew: ProcessNode[] = [
      ...existing,
      node({ id: "c", created_at: "2024-06-01T00:00:00Z" }),
    ];
    const after = processReferences(pools, [], withNew, focal("pool:intent_1"), "demo");

    expect(before.map((r) => [r.id, r.number])).toEqual([
      ["intent_1", 1],
      ["a", 2],
      ["b", 3],
    ]);
    expect(after.map((r) => [r.id, r.number])).toEqual([
      ["intent_1", 1],
      ["a", 2],
      ["b", 3],
      ["c", 4],
    ]);
  });

  it("breaks a created_at tie by id for determinism", () => {
    const nodes: ProcessNode[] = [
      node({ id: "node_z", created_at: "2024-01-01T00:00:00Z" }),
      node({ id: "node_a", created_at: "2024-01-01T00:00:00Z" }),
    ];

    const refs = processReferences([], [], nodes, focal("pool:intent_1"), "demo");

    expect(refs.map((r) => r.id)).toEqual(["node_a", "node_z"]);
  });

  it("skips the Unassigned pool and synthetic / catch-all lanes even when focal", () => {
    const pools: ProcessPool[] = [
      pool({
        id: "pool:intent_1",
        intent_id: "intent_1",
        label: "Real intent",
        lifecycle: "active",
      }),
      pool({ id: "__unassigned__", intent_id: null, label: "Unassigned" }),
    ];
    const lanes: ProcessLane[] = [
      lane({
        id: "pool:intent_1::principal_a",
        kind: "actor",
        label: "Alice",
        lifecycle: "active",
      }),
      lane({ id: "pool:intent_1::__milestones__", kind: "milestone", label: "Milestones" }),
      lane({ id: "pool:intent_1::__artifacts__", kind: "artifacts", label: "Artifacts" }),
    ];

    const refs = processReferences(
      pools,
      lanes,
      [],
      focal("pool:intent_1", "__unassigned__"),
      "demo",
    );

    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.entity_type)).toEqual(["intent", "principal"]);
    expect(refs.map((r) => r.number)).toEqual([1, 2]);
  });

  it("omits the href when no doco handle is known", () => {
    const refs = processReferences(
      [pool({ id: "pool:intent_1", intent_id: "intent_1", label: "Intent", lifecycle: "active" })],
      [],
      [],
      focal("pool:intent_1"),
      null,
    );
    expect(refs[0]?.href).toBeNull();
  });
});
