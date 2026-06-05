import { describe, expect, it } from "vitest";
import type { ProcessLane, ProcessPool } from "../process-perspective.server";
import { type ProcessNodeReference, processReferences } from "../process-references";

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

function node(
  overrides: Partial<ProcessNodeReference> & Pick<ProcessNodeReference, "id">,
): ProcessNodeReference {
  return {
    entity_type: "action",
    label: overrides.id,
    lifecycle: "active",
    href: null,
    position: { x: 0, y: 0 },
    height: 60,
    ...overrides,
  };
}

describe("processReferences", () => {
  it("numbers the Intent pool first, then each principal swimlane, then flow nodes", () => {
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
    const nodes: ProcessNodeReference[] = [
      node({ id: "action_pick", label: "Pick items", position: { x: 100, y: 0 } }),
    ];

    const refs = processReferences(pools, lanes, nodes, "demo");

    expect(refs.map((r) => `#${r.number} ${r.entity_type}:${r.label}`)).toEqual([
      "#1 intent:Fulfill customer orders",
      "#2 principal:Sales",
      "#3 principal:Warehouse",
      "#4 action:Pick items",
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

  it("orders flow nodes by canvas reading order: top-to-bottom row, then left-to-right", () => {
    // Numbers come from the canvas layout, never the viewport — so this is a
    // pure function of the rendered positions. A above B/C; B and C share a
    // row (their vertical gap is within a node's height), so C (left) precedes
    // B (right).
    const nodes: ProcessNodeReference[] = [
      node({ id: "n_right", position: { x: 300, y: 200 }, height: 60 }),
      node({ id: "n_top", position: { x: 50, y: 0 }, height: 60 }),
      node({ id: "n_left", position: { x: 40, y: 230 }, height: 60 }),
    ];

    const refs = processReferences([], [], nodes, "demo");

    expect(refs.map((r) => `#${r.number} ${r.id}`)).toEqual([
      "#1 n_top",
      "#2 n_left",
      "#3 n_right",
    ]);
  });

  it("breaks an exact position tie by id for determinism", () => {
    const nodes: ProcessNodeReference[] = [
      node({ id: "node_z", position: { x: 0, y: 0 } }),
      node({ id: "node_a", position: { x: 0, y: 0 } }),
    ];

    const refs = processReferences([], [], nodes, "demo");

    expect(refs.map((r) => r.id)).toEqual(["node_a", "node_z"]);
  });

  it("skips the Unassigned pool and synthetic / catch-all lanes", () => {
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

    const refs = processReferences(pools, lanes, [], "demo");

    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.entity_type)).toEqual(["intent", "principal"]);
    expect(refs.map((r) => r.number)).toEqual([1, 2]);
  });

  it("omits the href when no doco handle is known", () => {
    const refs = processReferences(
      [pool({ id: "pool:intent_1", intent_id: "intent_1", label: "Intent", lifecycle: "active" })],
      [],
      [],
      null,
    );
    expect(refs[0]?.href).toBeNull();
  });
});
