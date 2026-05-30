import { describe, expect, it } from "vitest";
import {
  ORG_TREE_NODE_H,
  ORG_TREE_NODE_W,
  ORG_TREE_V_GAP,
  layoutOrgTree,
} from "../org-tree-layout";
import type { OrgTreeNode } from "../org-tree-perspective.server";

function principal(
  id: string,
  reportsTo: string | null = null,
  dottedReportsTo: string[] = [],
): OrgTreeNode {
  return {
    id,
    name: id,
    role: null,
    type: "person",
    lifecycle: "asserted",
    reports_to: reportsTo,
    dotted_reports_to: dottedReportsTo,
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

  it("adds dotted (matrix) edges without reparenting the node in the tree", () => {
    // b reports primarily to root, dotted-line to a. The primary tree
    // must still place b under root; the dotted edge layers on top.
    const layout = layoutOrgTree(
      [
        principal("principal_root"),
        principal("principal_a", "principal_root"),
        principal("principal_b", "principal_root", ["principal_a"]),
      ],
      null,
    );
    const solid = layout.edges.filter((e) => !e.dotted).map((e) => [e.source, e.target]);
    const dotted = layout.edges.filter((e) => e.dotted).map((e) => [e.source, e.target]);
    // primary tree edges unchanged (root→a, root→b)
    expect(solid.sort()).toEqual([
      ["principal_root", "principal_a"],
      ["principal_root", "principal_b"],
    ]);
    // one dashed matrix edge a→b
    expect(dotted).toEqual([["principal_a", "principal_b"]]);
  });

  it("drops dotted edges that point outside the active node set", () => {
    const layout = layoutOrgTree(
      [
        principal("principal_root"),
        principal("principal_x", "principal_root", ["principal_ghost"]),
      ],
      null,
    );
    expect(layout.edges.some((e) => e.dotted)).toBe(false);
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
