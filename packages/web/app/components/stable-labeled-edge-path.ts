import { Position } from "@xyflow/react";

const EDGE_STREET_PX = 14;
const EDGE_MIN_CONTROL_PX = 20;
const EDGE_MAX_CONTROL_PX = 180;
const EDGE_MIN_BEND_SEGMENT_PX = EDGE_STREET_PX * 2;
const EDGE_DETOUR_PX = EDGE_STREET_PX * 4;

interface StreetBezierPathArgs {
  sourceX: number;
  sourceY: number;
  sourcePosition?: Position;
  targetX: number;
  targetY: number;
  targetPosition?: Position;
}

interface UnitVector {
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

function unitForPosition(position: Position | undefined, fallback: UnitVector): UnitVector {
  switch (position) {
    case Position.Left:
      return { x: -1, y: 0 };
    case Position.Right:
      return { x: 1, y: 0 };
    case Position.Top:
      return { x: 0, y: -1 };
    case Position.Bottom:
      return { x: 0, y: 1 };
    default:
      return fallback;
  }
}

function normalize(dx: number, dy: number, fallback: UnitVector): UnitVector {
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return fallback;
  return { x: dx / length, y: dy / length };
}

function pointAt(x: number, y: number, direction: UnitVector, distance: number): Point {
  return {
    x: x + direction.x * distance,
    y: y + direction.y * distance,
  };
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
}

function pushPoint(points: Point[], point: Point) {
  const previous = points.at(-1);
  if (!previous || !samePoint(previous, point)) points.push(point);
}

function polylinePath(points: Point[]): string {
  if (points.length < 2) return "";

  let path = `M ${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    path += ` L ${point.x},${point.y}`;
  }
  return path;
}

function labelPointForPolyline(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];

  const segmentLengths = points.slice(1).map((point, index) => {
    const previous = points[index];
    return Math.hypot(point.x - previous.x, point.y - previous.y);
  });
  const total = segmentLengths.reduce((sum, length) => sum + length, 0);
  let remaining = total / 2;

  for (let index = 0; index < segmentLengths.length; index++) {
    const length = segmentLengths[index];
    if (remaining <= length || index === segmentLengths.length - 1) {
      const start = points[index];
      const end = points[index + 1];
      const progress = length > 0 ? remaining / length : 0;
      return {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      };
    }
    remaining -= length;
  }

  return points.at(-1) ?? points[0];
}

function pointWith(primary: "x" | "y", primaryValue: number, secondaryValue: number): Point {
  return primary === "x"
    ? { x: primaryValue, y: secondaryValue }
    : { x: secondaryValue, y: primaryValue };
}

function orthogonalStreetPath({
  sourceX,
  sourceY,
  sourceDirection,
  targetX,
  targetY,
  targetDirection,
}: {
  sourceX: number;
  sourceY: number;
  sourceDirection: UnitVector;
  targetX: number;
  targetY: number;
  targetDirection: UnitVector;
}): [string, number, number] | null {
  const sourcePrimaryAxis = sourceDirection.x !== 0 ? "x" : sourceDirection.y !== 0 ? "y" : null;
  const targetPrimaryAxis = targetDirection.x !== 0 ? "x" : targetDirection.y !== 0 ? "y" : null;
  if (!sourcePrimaryAxis || sourcePrimaryAxis !== targetPrimaryAxis) return null;

  const primary = sourcePrimaryAxis;
  const secondary = primary === "x" ? "y" : "x";
  const sourceSign = sourceDirection[primary];
  const targetSign = targetDirection[primary];
  if (sourceSign === 0 || targetSign === 0) return null;

  const source = { x: sourceX, y: sourceY };
  const target = { x: targetX, y: targetY };
  const sourceStreet = pointAt(sourceX, sourceY, sourceDirection, EDGE_STREET_PX);
  const targetStreet = pointAt(targetX, targetY, targetDirection, EDGE_STREET_PX);
  const primaryGap = Math.abs(targetStreet[primary] - sourceStreet[primary]);
  const secondaryGap = Math.abs(targetStreet[secondary] - sourceStreet[secondary]);
  const sourceFacesTarget = Math.sign(targetStreet[primary] - sourceStreet[primary]) === sourceSign;
  const targetFacesSource = Math.sign(sourceStreet[primary] - targetStreet[primary]) === targetSign;
  const points: Point[] = [source];
  pushPoint(points, sourceStreet);

  if (
    sourceFacesTarget &&
    targetFacesSource &&
    primaryGap >= EDGE_MIN_BEND_SEGMENT_PX * 2 &&
    secondaryGap >= EDGE_MIN_BEND_SEGMENT_PX
  ) {
    const middlePrimary = (sourceStreet[primary] + targetStreet[primary]) / 2;
    pushPoint(points, pointWith(primary, middlePrimary, sourceStreet[secondary]));
    pushPoint(points, pointWith(primary, middlePrimary, targetStreet[secondary]));
  } else if (sourceFacesTarget && targetFacesSource && secondaryGap < EDGE_MIN_BEND_SEGMENT_PX) {
    pushPoint(points, targetStreet);
  } else {
    const detourPrimary =
      sourceSign > 0
        ? Math.max(sourceStreet[primary], targetStreet[primary]) + EDGE_MIN_BEND_SEGMENT_PX
        : Math.min(sourceStreet[primary], targetStreet[primary]) - EDGE_MIN_BEND_SEGMENT_PX;
    pushPoint(points, pointWith(primary, detourPrimary, sourceStreet[secondary]));
    if (secondaryGap < EDGE_MIN_BEND_SEGMENT_PX) {
      const secondarySign = Math.sign(targetStreet[secondary] - sourceStreet[secondary]) || 1;
      const detourSecondary =
        secondarySign > 0
          ? Math.max(sourceStreet[secondary], targetStreet[secondary]) + EDGE_DETOUR_PX
          : Math.min(sourceStreet[secondary], targetStreet[secondary]) - EDGE_DETOUR_PX;
      pushPoint(points, pointWith(primary, detourPrimary, detourSecondary));
      pushPoint(points, pointWith(primary, targetStreet[primary], detourSecondary));
    } else {
      pushPoint(points, pointWith(primary, detourPrimary, targetStreet[secondary]));
    }
  }

  pushPoint(points, targetStreet);
  pushPoint(points, target);

  const path = polylinePath(points);
  const label = labelPointForPolyline(points);
  return [path, label.x, label.y];
}

export function getStreetBezierPath({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
}: StreetBezierPathArgs): [string, number, number] {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const street = Math.min(EDGE_STREET_PX, distance / 3);
  const sourceDirection = unitForPosition(sourcePosition, normalize(dx, dy, { x: 1, y: 0 }));
  const targetDirection = unitForPosition(targetPosition, normalize(-dx, -dy, { x: -1, y: 0 }));
  const streetPath = orthogonalStreetPath({
    sourceX,
    sourceY,
    sourceDirection,
    targetX,
    targetY,
    targetDirection,
  });
  if (streetPath) return streetPath;

  const sourceStreet = pointAt(sourceX, sourceY, sourceDirection, street);
  const targetStreet = pointAt(targetX, targetY, targetDirection, street);
  const middleDistance = Math.hypot(
    targetStreet.x - sourceStreet.x,
    targetStreet.y - sourceStreet.y,
  );
  const controlDistance = Math.min(
    EDGE_MAX_CONTROL_PX,
    Math.max(EDGE_MIN_CONTROL_PX, middleDistance * 0.45),
    Math.max(0, middleDistance / 2),
  );
  const controlSource = pointAt(sourceStreet.x, sourceStreet.y, sourceDirection, controlDistance);
  const controlTarget = pointAt(targetStreet.x, targetStreet.y, targetDirection, controlDistance);
  const path = [
    `M ${sourceX},${sourceY}`,
    `L ${sourceStreet.x},${sourceStreet.y}`,
    `C ${controlSource.x},${controlSource.y} ${controlTarget.x},${controlTarget.y} ${targetStreet.x},${targetStreet.y}`,
    `L ${targetX},${targetY}`,
  ].join(" ");

  return [path, (sourceX + targetX) / 2, (sourceY + targetY) / 2];
}
