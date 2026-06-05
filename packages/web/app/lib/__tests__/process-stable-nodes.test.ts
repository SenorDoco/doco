import { describe, expect, it } from "vitest";
import { indexById, reuseStableNodes, sameFlowNode } from "../process-stable-nodes";

interface TestNode {
  id: string;
  type?: string;
  parentId?: string;
  className?: string;
  hidden?: boolean;
  zIndex?: number;
  draggable?: boolean;
  selectable?: boolean;
  connectable?: boolean;
  position: { x: number; y: number };
  style?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function node(overrides: Partial<TestNode> & { id: string }): TestNode {
  return {
    type: "processRectangle",
    position: { x: 0, y: 0 },
    style: { opacity: 1 },
    data: {},
    ...overrides,
  };
}

describe("sameFlowNode", () => {
  it("treats two freshly-built nodes with identical render inputs as the same", () => {
    const sharedNode = { lifecycle: "active" };
    const a = node({ id: "n1", data: { node: sharedNode, isCenter: false } });
    const b = node({ id: "n1", data: { node: sharedNode, isCenter: false } });
    // Different object identities (style/data/position all fresh) but
    // identical contents — the layout re-ran without changing this node.
    expect(a).not.toBe(b);
    expect(sameFlowNode(a, b)).toBe(true);
  });

  it("detects an opacity change in style", () => {
    const a = node({ id: "n1", style: { opacity: 1 } });
    const b = node({ id: "n1", style: { opacity: 0.25 } });
    expect(sameFlowNode(a, b)).toBe(false);
  });

  it("detects a position change", () => {
    const a = node({ id: "n1", position: { x: 0, y: 0 } });
    const b = node({ id: "n1", position: { x: 10, y: 0 } });
    expect(sameFlowNode(a, b)).toBe(false);
  });

  it("detects an isCenter (focal) change inside data", () => {
    const shared = { lifecycle: "active" };
    const a = node({ id: "n1", data: { node: shared, isCenter: false } });
    const b = node({ id: "n1", data: { node: shared, isCenter: true } });
    expect(sameFlowNode(a, b)).toBe(false);
  });

  it("detects a className change", () => {
    const a = node({ id: "n1", className: "doco-graph-fade" });
    const b = node({ id: "n1", className: "doco-graph-fade extra" });
    expect(sameFlowNode(a, b)).toBe(false);
  });

  it("treats a changed nested node reference as different", () => {
    const a = node({ id: "n1", data: { node: { lifecycle: "active" } } });
    const b = node({ id: "n1", data: { node: { lifecycle: "retired" } } });
    expect(sameFlowNode(a, b)).toBe(false);
  });
});

describe("reuseStableNodes", () => {
  it("reuses the previous object identity for unchanged nodes", () => {
    const prev = [node({ id: "a" }), node({ id: "b" })];
    const prevById = indexById(prev);

    // Rebuild with identical contents but brand-new object identities,
    // as a re-render of the memo would produce.
    const next = [node({ id: "a" }), node({ id: "b" })];
    const stable = reuseStableNodes(next, prevById);

    expect(stable[0]).toBe(prev[0]);
    expect(stable[1]).toBe(prev[1]);
  });

  it("returns the new object only for nodes whose render inputs changed", () => {
    const prev = [
      node({ id: "a", style: { opacity: 1 } }),
      node({ id: "b", style: { opacity: 1 } }),
    ];
    const prevById = indexById(prev);

    const next = [
      node({ id: "a", style: { opacity: 1 } }), // unchanged
      node({ id: "b", style: { opacity: 0.5 } }), // faded
    ];
    const stable = reuseStableNodes(next, prevById);

    expect(stable[0]).toBe(prev[0]); // reused
    expect(stable[1]).toBe(next[1]); // new identity for the changed node
    expect(stable[1]).not.toBe(prev[1]);
  });

  it("uses the new object for nodes that did not exist before", () => {
    const prev = [node({ id: "a" })];
    const prevById = indexById(prev);
    const next = [node({ id: "a" }), node({ id: "c" })];
    const stable = reuseStableNodes(next, prevById);
    expect(stable[0]).toBe(prev[0]);
    expect(stable[1]).toBe(next[1]);
  });

  it("preserves order and length of the incoming array", () => {
    const prev = [node({ id: "a" }), node({ id: "b" })];
    const next = [node({ id: "b" }), node({ id: "a" }), node({ id: "c" })];
    const stable = reuseStableNodes(next, indexById(prev));
    expect(stable.map((n) => n.id)).toEqual(["b", "a", "c"]);
  });
});

describe("indexById", () => {
  it("maps each node by its id", () => {
    const a = node({ id: "a" });
    const b = node({ id: "b" });
    const map = indexById([a, b]);
    expect(map.get("a")).toBe(a);
    expect(map.get("b")).toBe(b);
    expect(map.size).toBe(2);
  });
});
