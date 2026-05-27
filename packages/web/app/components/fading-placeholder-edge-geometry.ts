import { getStraightPath } from "@xyflow/react";

interface FadingPlaceholderGeometryArgs {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  direction?: "incoming" | "outgoing";
  hasMarkerEnd?: boolean;
  markerClearance?: number;
}

export function getFadingPlaceholderGeometry({
  sourceX,
  sourceY,
  targetX,
  targetY,
  direction,
  hasMarkerEnd = false,
  markerClearance = 0,
}: FadingPlaceholderGeometryArgs) {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const shouldStopBeforeTarget = direction === "incoming" && hasMarkerEnd && markerClearance > 0;
  const clearance = shouldStopBeforeTarget ? Math.min(markerClearance, length / 2) : 0;
  const endX = targetX - (dx / length) * clearance;
  const endY = targetY - (dy / length) * clearance;
  const [path] = getStraightPath({ sourceX, sourceY, targetX: endX, targetY: endY });

  return { path, endX, endY, length: Math.max(1, Math.hypot(endX - sourceX, endY - sourceY)) };
}
