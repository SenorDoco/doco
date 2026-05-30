import type { OrgTreeNode } from "./org-tree-perspective.server";

export const ORG_TREE_NODE_W = 240;
export const ORG_TREE_NODE_H = 76;
export const ORG_TREE_H_GAP = 40;
export const ORG_TREE_V_GAP = 60;
const MAX_DEPTH = 50;

export interface OrgTreeLayoutNode {
  id: string;
  position: { x: number; y: number };
  org: OrgTreeNode;
  isCenter: boolean;
}

export interface OrgTreeLayoutEdge {
  id: string;
  source: string;
  target: string;
  /** Secondary / dotted-line (matrix) reporting edge — rendered dashed
   *  and excluded from the parent/child tree placement. */
  dotted?: boolean;
}

export interface OrgTreeLayout {
  nodes: OrgTreeLayoutNode[];
  edges: OrgTreeLayoutEdge[];
}

// Tree-layout entry point. Returns positioned nodes + parent/child
// edges; the React Flow component layers rendering-specific fields on
// top. Multiple roots lay out side-by-side. Cycles should not occur
// through the API, but imported data can be malformed, so any node not
// reachable from a root becomes a fallback root instead of vanishing.
export function layoutOrgTree(rawNodes: OrgTreeNode[], centerId: string | null): OrgTreeLayout {
  if (rawNodes.length === 0) return { nodes: [], edges: [] };

  const byId = new Map<string, OrgTreeNode>();
  for (const n of rawNodes) byId.set(n.id, n);

  // manager_id -> [report_ids]. Stable child order = creation order
  // (rawNodes is sorted by created_at server-side).
  const childrenOf = new Map<string, string[]>();
  for (const n of rawNodes) {
    if (n.reports_to && byId.has(n.reports_to) && n.reports_to !== n.id) {
      const list = childrenOf.get(n.reports_to) ?? [];
      list.push(n.id);
      childrenOf.set(n.reports_to, list);
    }
  }

  // Roots = Principals with no resolvable manager. Includes orphans
  // whose reports_to points outside the active set (e.g. a retired
  // manager) so they render as their own root rather than disappearing.
  const roots = rawNodes
    .filter((n) => !n.reports_to || !byId.has(n.reports_to) || n.reports_to === n.id)
    .map((n) => n.id);

  // Subtree widths, memoized + cycle-safe.
  const subtreeWidth = new Map<string, number>();
  const measureStack = new Set<string>();
  function measure(id: string): number {
    if (subtreeWidth.has(id)) return subtreeWidth.get(id) as number;
    if (measureStack.has(id)) {
      // Cycle: treat the recursive edge as a leaf to break recursion.
      subtreeWidth.set(id, ORG_TREE_NODE_W);
      return ORG_TREE_NODE_W;
    }
    measureStack.add(id);
    const children = childrenOf.get(id) ?? [];
    let width: number;
    if (children.length === 0) {
      width = ORG_TREE_NODE_W;
    } else {
      const total = children.reduce(
        (sum, childId, i) => sum + measure(childId) + (i > 0 ? ORG_TREE_H_GAP : 0),
        0,
      );
      width = Math.max(ORG_TREE_NODE_W, total);
    }
    measureStack.delete(id);
    subtreeWidth.set(id, width);
    return width;
  }

  const positions = new Map<string, { x: number; y: number }>();
  const placedStack = new Set<string>();
  function place(id: string, leftX: number, depth: number): void {
    if (depth > MAX_DEPTH || placedStack.has(id)) return;
    placedStack.add(id);
    const width = subtreeWidth.get(id) ?? measure(id);
    const x = leftX + width / 2 - ORG_TREE_NODE_W / 2;
    const y = depth * (ORG_TREE_NODE_H + ORG_TREE_V_GAP);
    positions.set(id, { x, y });
    let childX = leftX;
    for (const childId of childrenOf.get(id) ?? []) {
      place(childId, childX, depth + 1);
      childX += (subtreeWidth.get(childId) ?? measure(childId)) + ORG_TREE_H_GAP;
    }
  }

  let rootX = 0;
  const placeRoot = (rootId: string) => {
    const width = measure(rootId);
    place(rootId, rootX, 0);
    rootX += width + ORG_TREE_H_GAP;
  };

  for (const rootId of roots) placeRoot(rootId);
  for (const n of rawNodes) {
    if (!positions.has(n.id)) placeRoot(n.id);
  }

  const nodes = rawNodes
    .filter((n) => positions.has(n.id))
    .map((n) => ({
      id: n.id,
      position: positions.get(n.id) as { x: number; y: number },
      org: n,
      isCenter: n.id === centerId,
    }));

  const edges: OrgTreeLayoutEdge[] = rawNodes
    .filter((n) => n.reports_to && byId.has(n.reports_to) && n.reports_to !== n.id)
    .map((n) => ({
      id: `${n.id}->${n.reports_to}`,
      source: n.reports_to as string,
      target: n.id,
    }));

  // Secondary / dotted-line (matrix) edges layer on top of the tree —
  // they point manager→report like the solid edges but never affect
  // placement (the hierarchy above used `reports_to` only).
  for (const n of rawNodes) {
    for (const mgr of n.dotted_reports_to ?? []) {
      if (!byId.has(mgr) || mgr === n.id) continue;
      edges.push({ id: `${n.id}⇢${mgr}`, source: mgr, target: n.id, dotted: true });
    }
  }

  return { nodes, edges };
}
