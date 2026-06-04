/**
 * Layout for the BPMN flow nodes that render *outside* the one drawn swim
 * lane — the focal node's first-degree neighbours that belong to other
 * intents. The BPMN perspective draws a single pool (the focal node's
 * intent) in full; these adjacent nodes hug the pool above or below it,
 * on whichever edge they sit closer to, connected back to the focal node.
 *
 * Each node carries the side it belongs on (decided by the caller from the
 * vertical position of the in-pool node it attaches to). Within a side the
 * nodes lay out in a single horizontal row, centered on `centerX`, just
 * outside the pool band.
 *
 * Pure and deterministic: same inputs → same positions.
 */

export interface AdjacentNodeInput {
  id: string;
  width: number;
  height: number;
  side: "above" | "below";
}

export interface AdjacentLayoutOptions {
  /** Canvas x to center each row on (typically the focal node's center x). */
  centerX: number;
  /** Canvas y of the pool's top edge — the "above" row sits over it. */
  poolTopY: number;
  /** Canvas y of the pool's bottom edge — the "below" row sits under it. */
  poolBottomY: number;
  /** Vertical gap between the pool edge and the row of adjacent nodes. */
  gap: number;
  /** Horizontal gap between nodes within a row. */
  columnGap: number;
}

export function layoutAdjacentNodes(
  nodes: readonly AdjacentNodeInput[],
  opts: AdjacentLayoutOptions,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  for (const side of ["above", "below"] as const) {
    const row = nodes.filter((node) => node.side === side).sort((a, b) => a.id.localeCompare(b.id));
    if (row.length === 0) continue;
    const totalWidth = row.reduce(
      (sum, node, index) => sum + node.width + (index > 0 ? opts.columnGap : 0),
      0,
    );
    let x = opts.centerX - totalWidth / 2;
    for (const node of row) {
      // "above": sit the whole node above the pool's top edge. "below":
      // hang it just under the pool's bottom edge.
      const y =
        side === "above" ? opts.poolTopY - opts.gap - node.height : opts.poolBottomY + opts.gap;
      positions.set(node.id, { x, y });
      x += node.width + opts.columnGap;
    }
  }
  return positions;
}
