import { describe, expect, it } from "vitest";
import {
  ORG_TREE_NODE_H,
  ORG_TREE_NODE_W,
  ORG_TREE_V_GAP,
  layoutOrgTree,
} from "../org-tree-layout";
import type { OrgTreeNode } from "../org-tree-perspective.server";

function principal(id: string, reportsTo: string | null = null): OrgTreeNode {
  return {
    id,
    name: id,
    description: null,
    type: "person",
    lifecycle: "active",
    reports_to: reportsTo,
    href: `/acme/principal/${id}`,
  };
}

describe("layoutOrgTree", () => {
  it("uses measured subtree widths so cousin branches do not overlap", () => {
    const layout = layoutOrgTree(
      [
        principal("principal_root"),
        principal("principal_a", "principal_root"),
        principal("principal_b", "principal_root"),
        principal("principal_a1", "principal_a"),
        principal("principal_a2", "principal_a"),
        principal("principal_b1", "principal_b"),
        principal("principal_b2", "principal_b"),
      ],
      null,
    );

    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const leafY = ORG_TREE_NODE_H + ORG_TREE_V_GAP + ORG_TREE_NODE_H + ORG_TREE_V_GAP;
    const leafXs = ["principal_a1", "principal_a2", "principal_b1", "principal_b2"].map(
      (id) => byId.get(id)?.position.x,
    );

    expect(leafXs.every((x) => typeof x === "number")).toBe(true);
    expect(new Set(leafXs).size).toBe(4);
    expect(byId.get("principal_a2")?.position.x).toBeLessThan(
      byId.get("principal_b1")?.position.x ?? 0,
    );
    expect(byId.get("principal_a1")?.position.y).toBe(leafY);
  });

  it("keeps cyclic imported data visible as fallback roots", () => {
    const layout = layoutOrgTree(
      [principal("principal_a", "principal_b"), principal("principal_b", "principal_a")],
      "principal_b",
    );

    expect(layout.nodes.map((n) => n.id).sort()).toEqual(["principal_a", "principal_b"]);
    expect(layout.edges.map((e) => [e.source, e.target]).sort()).toEqual([
      ["principal_a", "principal_b"],
      ["principal_b", "principal_a"],
    ]);
    expect(layout.nodes.find((n) => n.id === "principal_b")?.isCenter).toBe(true);
    for (const n of layout.nodes) {
      expect(n.position.x).toBeGreaterThanOrEqual(0);
      expect(n.position.x).toBeLessThan(ORG_TREE_NODE_W * 2);
    }
  });
});
