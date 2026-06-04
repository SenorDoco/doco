import { describe, expect, it } from "vitest";
import type { BpmnLane, BpmnPool } from "../bpmn-perspective.server";
import { bpmnPriorityReferences } from "../bpmn-references";

function pool(overrides: Partial<BpmnPool> & Pick<BpmnPool, "id">): BpmnPool {
  return {
    intent_id: null,
    label: "Pool",
    lifecycle: null,
    ...overrides,
  };
}

function lane(overrides: Partial<BpmnLane> & Pick<BpmnLane, "id" | "kind">): BpmnLane {
  return {
    pool_id: "pool:intent_1",
    base_id: "principal_1",
    label: "Lane",
    lifecycle: null,
    ...overrides,
  };
}

describe("bpmnPriorityReferences", () => {
  it("numbers the Intent pool first, then each principal swimlane", () => {
    const pools: BpmnPool[] = [
      pool({
        id: "pool:intent_1",
        intent_id: "intent_1",
        label: "Fulfill customer orders",
        lifecycle: "active",
      }),
    ];
    const lanes: BpmnLane[] = [
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

    const refs = bpmnPriorityReferences(pools, lanes, "demo");

    expect(refs.map((r) => `#${r.number} ${r.entity_type}:${r.label}`)).toEqual([
      "#1 intent:Fulfill customer orders",
      "#2 principal:Sales",
      "#3 principal:Warehouse",
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

  it("skips the Unassigned pool and synthetic / catch-all lanes", () => {
    const pools: BpmnPool[] = [
      pool({
        id: "pool:intent_1",
        intent_id: "intent_1",
        label: "Real intent",
        lifecycle: "active",
      }),
      pool({ id: "__unassigned__", intent_id: null, label: "Unassigned" }),
    ];
    const lanes: BpmnLane[] = [
      lane({
        id: "pool:intent_1::principal_a",
        kind: "actor",
        label: "Alice",
        lifecycle: "active",
      }),
      lane({ id: "pool:intent_1::__milestones__", kind: "milestone", label: "Milestones" }),
      lane({ id: "pool:intent_1::__artifacts__", kind: "artifacts", label: "Artifacts" }),
    ];

    const refs = bpmnPriorityReferences(pools, lanes, "demo");

    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.entity_type)).toEqual(["intent", "principal"]);
    expect(refs.map((r) => r.number)).toEqual([1, 2]);
  });

  it("omits the href when no doco handle is known", () => {
    const refs = bpmnPriorityReferences(
      [pool({ id: "pool:intent_1", intent_id: "intent_1", label: "Intent", lifecycle: "active" })],
      [],
      null,
    );
    expect(refs[0]?.href).toBeNull();
  });
});
