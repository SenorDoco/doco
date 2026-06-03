/**
 * Layout for the BPMN flow nodes that render *outside* the one drawn
 * swim lane. The BPMN perspective draws a single pool at a time — the
 * one owning the focused node. Every other node that survives the
 * render budget still shows, but it is not nested in a swim lane;
 * instead it is positioned purely by its graph distance from the focal
 * node, in distance-banded columns next to the drawn pool.
 *
 * Band 0 sits closest to the pool; each successive band (one BFS hop
 * further from the focal node) is a column further out. Unreachable
 * nodes collapse into the outermost band. Within a band, nodes stack
 * vertically, centered on the focal node's y, so the neighbourhood
 * reads as a halo of decreasing relatedness around the focus.
 *
 * Pure and deterministic: same inputs → same positions, so the camera
 * and reference numbering stay stable across renders.
 */

export interface OutsideNodeSize {
  id: string;
  width: number;
  height: number;
}

export interface OutsideLayoutOptions {
  /** Canvas x where the first (closest) band's column begins. */
  originX: number;
  /** Canvas y to vertically center each band's stack on (focal node center). */
  focalY: number;
  /** Horizontal gap between successive distance bands. */
  columnGap: number;
  /** Vertical gap between stacked nodes within a band. */
  rowGap: number;
}

// Distance bucket for nodes unreachable from the focal node — they sort
// after every finite-distance band, in the outermost column.
const UNREACHABLE_BAND = Number.MAX_SAFE_INTEGER;

export function layoutOutsideNodes(
  outsiders: readonly OutsideNodeSize[],
  depthByNode: ReadonlyMap<string, number>,
  opts: OutsideLayoutOptions,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (outsiders.length === 0) return positions;

  const bands = new Map<number, OutsideNodeSize[]>();
  for (const node of outsiders) {
    const depth = depthByNode.get(node.id);
    const band = depth === undefined ? UNREACHABLE_BAND : depth;
    const list = bands.get(band) ?? [];
    list.push(node);
    bands.set(band, list);
  }

  const sortedBands = [...bands.keys()].sort((a, b) => a - b);
  let columnX = opts.originX;
  for (const band of sortedBands) {
    const list = bands.get(band) ?? [];
    list.sort((a, b) => a.id.localeCompare(b.id));
    const columnWidth = list.reduce((max, node) => Math.max(max, node.width), 0);
    const totalHeight = list.reduce(
      (sum, node, index) => sum + node.height + (index > 0 ? opts.rowGap : 0),
      0,
    );
    let y = opts.focalY - totalHeight / 2;
    for (const node of list) {
      // Center each node within its band's column so varied widths line
      // up by their middle, matching the in-lane column behavior.
      const x = columnX + (columnWidth - node.width) / 2;
      positions.set(node.id, { x, y });
      y += node.height + opts.rowGap;
    }
    columnX += columnWidth + opts.columnGap;
  }
  return positions;
}
