// Vertical placement of one swim lane's nodes.
//
// Columns are solved upstream (longest-path sequence depth); this decides
// each node's vertical CENTER within the lane, and the top-to-bottom ORDER of
// the nodes that share a column. Both follow the flow:
//
//   • A node's preferred line is the average vertical center of its in-lane
//     predecessors (its barycenter). One predecessor ⇒ the node sits exactly
//     on that predecessor's line, so a straight `flows_to` chain stays
//     horizontal; a merge sits between the lines it joins. A node with no
//     placed predecessor (a root) falls back to the lane center.
//   • A column is ordered top-to-bottom by that preferred line. This is what
//     keeps edges from the previous column from crossing — and what lets the
//     alignment actually take hold: if a column kept creation order instead,
//     a later-created node wanting a high line could be pinned below an
//     earlier one wanting a low line, and the overlap solver would pool both
//     back to the middle, undoing the alignment.
//
// Preferred lines collide (a fork, or two chains converging on one row); when
// they do the nodes split evenly around the shared line and never overlap.

export interface LaneRowNode {
  id: string;
  /** Sequence-depth column; nodes sharing a column share a vertical stack. */
  column: number;
  height: number;
  /**
   * Same-lane forward predecessors (always in earlier columns). The node is
   * drawn at their average vertical center.
   */
  predecessors: readonly string[];
  /** Stable tiebreak (creation order) when two nodes prefer the same line. */
  order: number;
}

/** Center y (within the lane) for every node. Consecutive nodes never overlap. */
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
  // Left to right: a predecessor always sits in an earlier column, so its
  // center is already placed when its follower is positioned.
  for (const column of [...byColumn.keys()].sort((a, b) => a - b)) {
    const stack = byColumn.get(column) as LaneRowNode[];
    const preferred = new Map<string, number>();
    for (const node of stack) {
      const placed = node.predecessors
        .map((id) => centerById.get(id))
        .filter((center): center is number => center !== undefined);
      const sum = placed.reduce((total, center) => total + center, 0);
      preferred.set(node.id, placed.length > 0 ? sum / placed.length : laneCenter);
    }
    // Order the column by the flow (preferred line); creation order breaks
    // ties and orders an all-roots column.
    const ordered = [...stack].sort((a, b) => {
      const delta = (preferred.get(a.id) as number) - (preferred.get(b.id) as number);
      return delta !== 0 ? delta : a.order - b.order;
    });
    const centers = placeOrdered(
      ordered.map((node) => preferred.get(node.id) as number),
      ordered.map((node) => node.height),
      gap,
    );
    ordered.forEach((node, index) => centerById.set(node.id, centers[index]));
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
  // Minimum center-to-center separation accumulated from the first node.
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
