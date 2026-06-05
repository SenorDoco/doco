export interface ProcessLanePackingNode {
  id: string;
  laneId: string;
  created_at?: string | null;
}

export interface ProcessLanePackingResult<TNode extends ProcessLanePackingNode> {
  orderedByLane: Map<string, TNode[]>;
  columnByNode: Map<string, number>;
  stackIndexByNode: Map<string, number>;
  laneColumnStacks: Map<string, TNode[]>;
  maxColumn: number;
}

export function packProcessLaneColumns<TNode extends ProcessLanePackingNode>(
  laneIds: readonly string[],
  nodes: readonly TNode[],
  depthByNode: ReadonlyMap<string, number>,
): ProcessLanePackingResult<TNode> {
  const orderedByLane = new Map<string, TNode[]>();
  for (const laneId of laneIds) orderedByLane.set(laneId, []);

  for (const node of nodes) {
    orderedByLane.get(node.laneId)?.push(node);
  }

  for (const list of orderedByLane.values()) {
    list.sort((a, b) => compareLaneNodes(a, b, depthByNode));
  }

  const columnByNode = new Map<string, number>();
  const stackIndexByNode = new Map<string, number>();
  const laneColumnStacks = new Map<string, TNode[]>();
  let maxColumn = 0;

  for (const [laneId, list] of orderedByLane.entries()) {
    for (const node of list) {
      const column = depthByNode.get(node.id) ?? 0;
      maxColumn = Math.max(maxColumn, column);
      columnByNode.set(node.id, column);

      const key = processLaneColumnKey(laneId, column);
      const stack = laneColumnStacks.get(key) ?? [];
      stackIndexByNode.set(node.id, stack.length);
      stack.push(node);
      laneColumnStacks.set(key, stack);
    }
  }

  return { orderedByLane, columnByNode, stackIndexByNode, laneColumnStacks, maxColumn };
}

export function processLaneColumnKey(laneId: string, column: number): string {
  return `${laneId}\u0000${column}`;
}

function compareLaneNodes<TNode extends ProcessLanePackingNode>(
  a: TNode,
  b: TNode,
  depthByNode: ReadonlyMap<string, number>,
): number {
  const da = depthByNode.get(a.id) ?? 0;
  const db = depthByNode.get(b.id) ?? 0;
  if (da !== db) return da - db;
  const at = a.created_at ? Date.parse(a.created_at) : 0;
  const bt = b.created_at ? Date.parse(b.created_at) : 0;
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}
