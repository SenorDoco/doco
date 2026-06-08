import { Position, getBezierPath, getSmoothStepPath } from "@xyflow/react";

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

// A backward edge — one whose target sits left of its source, e.g. a
// gateway's feedback loop — routes orthogonally with rounded corners rather
// than as a bezier. A single bezier doubling back folds onto itself into a
// zero-radius cusp (the unreadable 180° spike); a smoothstep never cusps and
// reads cleanly whether the loop spans one row or many.
export const BACKWARD_EDGE_RADIUS = 12; // px corner radius for the orthogonal route
// When a backward edge is near same-row, the orthogonal route has no vertical
// room and collapses flat onto the node row. Drop its middle segment this far
// below both endpoints so the loop clears the node boxes and stays readable.
// Sized to clear the NODE_HEIGHT (60px) floor used by the process layout.
export const BACKWARD_LOOP_DROP = 52; // px

/**
 * Picks the path a process edge should draw. Forward edges keep React Flow's
 * bezier; an edge the layout marked as blocked arcs over/under the obstacle;
 * a backward edge routes as a smoothstep loop. Returns the SVG path plus the
 * label anchor, matching React Flow's path helpers.
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
    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: BACKWARD_EDGE_RADIUS,
      // Near same-row the default middle segment (the endpoints' midpoint)
      // lands on the node row and renders flat; force it below both endpoints.
      ...(Math.abs(dy) < 2 * BACKWARD_LOOP_DROP
        ? { centerY: Math.max(sourceY, targetY) + BACKWARD_LOOP_DROP }
        : {}),
    });
    return [path, labelX, labelY];
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
