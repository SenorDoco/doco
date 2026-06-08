// Vertical placement of one swim lane's nodes.
//
// Columns are solved upstream (longest-path sequence depth); this decides
// each node's vertical CENTER within the lane. The default is the old
// behavior — a column's nodes stack and the stack centers in the lane. The
// one addition: a node whose only forward sequence predecessor sits in the
// same lane is drawn on that predecessor's line, so a straight `flows_to`
// chain stays on one horizontal row instead of re-centering column by column
// (which sent arrows diagonally across neighbouring shapes). When two nodes
// want the same line they split around it — alignment is honored only when
// there is room, never at the cost of an overlap.

export interface LaneRowNode {
  id: string;
  /** Sequence-depth column; nodes sharing a column share a vertical stack. */
  column: number;
  height: number;
  /**
   * The id of this node's lone same-lane forward predecessor, when it has
   * exactly one. The node is drawn at that predecessor's vertical center if
   * the column has room for it there.
   */
  alignTo?: string;
}

/**
 * Center y (within the lane) for every node. Input order is the stack order
 * within each column (top to bottom); the result preserves it and never
 * overlaps consecutive nodes.
 */
export function computeLaneRowCenters(
  nodes: readonly LaneRowNode[],
  laneHeight: number,
  gap: number,
): Map<string, number> {
  const laneCenter = laneHeight / 2;
  const byColumn = new Map<number, LaneRowNode[]>();
  for (const node of nodes) {
    const list = byColumn.get(node.column);
    if (list) list.push(node);
    else byColumn.set(node.column, [node]);
  }

  const centerById = new Map<string, number>();
  // Left to right: a forward predecessor always sits in an earlier column,
  // so its center is already placed when its follower is positioned.
  for (const column of [...byColumn.keys()].sort((a, b) => a - b)) {
    const stack = byColumn.get(column) as LaneRowNode[];
    const desired = stack.map((node) => {
      const anchor = node.alignTo !== undefined ? centerById.get(node.alignTo) : undefined;
      return anchor ?? laneCenter;
    });
    const placed = placeOrdered(
      desired,
      stack.map((node) => node.height),
      gap,
    );
    stack.forEach((node, index) => centerById.set(node.id, placed[index]));
  }
  return centerById;
}

/**
 * Place ordered items at centers as close as possible to `desired` while
 * keeping their order and a minimum gap between neighbours. Subtracting each
 * item's forced cumulative offset turns the non-overlap constraint into a
 * monotonic one, which L2 isotonic regression solves exactly.
 */
function placeOrdered(
  desired: readonly number[],
  heights: readonly number[],
  gap: number,
): number[] {
  const n = desired.length;
  if (n === 0) return [];
  // Minimum center-to-center separation between consecutive nodes.
  const cum: number[] = new Array(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + (heights[i - 1] + heights[i]) / 2 + gap;
  }
  const shifted = desired.map((d, i) => d - cum[i]);
  const fitted = isotonicFit(shifted);
  return fitted.map((y, i) => y + cum[i]);
}

/**
 * L2 isotonic regression: the non-decreasing sequence closest to `values`,
 * via pool-adjacent-violators. Equal-weight points, merged into level blocks.
 */
function isotonicFit(values: readonly number[]): number[] {
  const mean: number[] = [];
  const weight: number[] = [];
  const count: number[] = [];
  for (const value of values) {
    let m = value;
    let w = 1;
    let c = 1;
    while (mean.length > 0 && (mean[mean.length - 1] as number) > m) {
      const pm = mean.pop() as number;
      const pw = weight.pop() as number;
      const pc = count.pop() as number;
      m = (m * w + pm * pw) / (w + pw);
      w += pw;
      c += pc;
    }
    mean.push(m);
    weight.push(w);
    count.push(c);
  }
  const out: number[] = [];
  for (let block = 0; block < mean.length; block++) {
    for (let k = 0; k < (count[block] as number); k++) out.push(mean[block] as number);
  }
  return out;
}
