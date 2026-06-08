import { Position, getBezierPath } from "@xyflow/react";

export interface StableEdgeGeometryInput {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
  /** Vertical bow applied when a node blocks this edge's straight path.
   *  `bowLift` is the cubic control-point offset in px; `bowDir` is -1 to
   *  arc up (toward smaller y) or 1 to arc down. Both come from the layout
   *  (which knows node geometry); absent means no obstacle. */
  bowDir?: 1 | -1;
  bowLift?: number;
}

// A backward edge — one whose target sits left of its source, e.g. a feedback
// loop or a flow back to an entry point — draws with the SAME bezier as every
// forward edge, so the canvas reads as one consistent family of curves rather
// than a mix of smooth and squared-off routes. The only failure mode of a
// plain bezier here is the near-same-row case, where a doubling-back cubic
// folds onto itself into a zero-radius cusp. To avoid it the control points
// gain a vertical bow that grows as the two rows converge and tapers back to
// zero once they're a loop-height apart — so a well-separated backward edge is
// byte-for-byte React Flow's bezier, and a tight one lifts into a readable
// loop instead of a spike.
export const BACKWARD_LOOP_BOW = 72; // px max control-point bow for a same-row loop

// React Flow's bezier control reach (curvature 0.25): how far a control point
// extends from its endpoint along the handle axis. A negative distance (the
// handle points away from the other endpoint, as on a backward edge) uses the
// gentler sqrt reach so the curve still bulges outward.
const CURVATURE = 0.25;
function controlReach(distance: number): number {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
}

/**
 * Picks the path a process edge should draw. Forward edges keep React Flow's
 * bezier; an edge the layout marked as blocked arcs over/under the obstacle; a
 * backward edge uses the same bezier, bowed into a loop when it nears same-row.
 * Returns the SVG path plus the label anchor, matching React Flow's helpers.
 */
export function getStableEdgePath(
  input: StableEdgeGeometryInput,
): [path: string, labelX: number, labelY: number] {
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition } = input;
  const bowLift = typeof input.bowLift === "number" ? input.bowLift : 0;
  const bowDir = input.bowDir === 1 ? 1 : -1;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;

  // The layout sets bowLift/bowDir only when a node actually blocks this
  // roughly-horizontal forward edge (and which way to arc around it); apply
  // that vertical lift so the edge bows over/under the obstacle.
  if (bowLift > 0 && dx > 24 && Math.abs(dy) < 80) {
    const lift = bowLift * bowDir;
    const c1x = sourceX + dx * 0.25;
    const c2x = sourceX + dx * 0.75;
    return [
      `M${sourceX},${sourceY} C${c1x},${sourceY + lift} ${c2x},${targetY + lift} ${targetX},${targetY}`,
      sourceX + dx / 2,
      (sourceY + targetY) / 2 + lift * 0.75,
    ];
  }

  const isBackward =
    sourcePosition === Position.Right && targetPosition === Position.Left && targetX < sourceX;
  if (isBackward) {
    const reach = controlReach(dx); // dx < 0 here → the outward sqrt reach
    // Bow direction follows the (small) vertical drift; ties default to down.
    const dir = dy >= 0 ? 1 : -1;
    // Full bow at same-row, tapering to none once |dy| clears a loop height.
    const bow = Math.max(0, BACKWARD_LOOP_BOW - Math.abs(dy) / 2);
    const c1x = sourceX + reach;
    const c1y = sourceY + dir * bow;
    const c2x = targetX - reach;
    const c2y = targetY + dir * bow;
    return [
      `M${sourceX},${sourceY} C${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`,
      0.125 * sourceX + 0.375 * c1x + 0.375 * c2x + 0.125 * targetX,
      0.125 * sourceY + 0.375 * c1y + 0.375 * c2y + 0.125 * targetY,
    ];
  }

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return [path, labelX, labelY];
}
