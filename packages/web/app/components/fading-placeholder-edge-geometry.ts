import { getStraightPath } from "@xyflow/react";

const INCOMING_MARKER_CLEARANCE_PX = 14;

interface FadingPlaceholderGeometryArgs {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  direction?: "incoming" | "outgoing";
  hasMarkerEnd?: boolean;
}

export function getFadingPlaceholderGeometry({
  sourceX,
  sourceY,
  targetX,
  targetY,
  direction,
  hasMarkerEnd = false,
}: FadingPlaceholderGeometryArgs) {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const shouldStopBeforeTarget = direction === "incoming" && hasMarkerEnd;
  const clearance = shouldStopBeforeTarget ? Math.min(INCOMING_MARKER_CLEARANCE_PX, length / 2) : 0;
  const endX = targetX - (dx / length) * clearance;
  const endY = targetY - (dy / length) * clearance;
  const [path] = getStraightPath({ sourceX, sourceY, targetX: endX, targetY: endY });

  return { path, endX, endY, length: Math.max(1, Math.hypot(endX - sourceX, endY - sourceY)) };
}
