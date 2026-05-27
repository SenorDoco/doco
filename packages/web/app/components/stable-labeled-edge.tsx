import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, Position } from "@xyflow/react";
import type { CSSProperties } from "react";

const EDGE_STREET_PX = 20;
const EDGE_MIN_CONTROL_PX = 20;
const EDGE_MAX_CONTROL_PX = 180;

export interface StableLabeledEdgeData extends Record<string, unknown> {
  label?: string | null;
  labelClassName?: string;
  labelStyle?: CSSProperties;
  labelBoxClassName?: string;
  labelBoxStyle?: CSSProperties;
  labelOpacity?: number;
  labelZIndex?: number;
}

export type StableLabeledEdgeModel = Edge<StableLabeledEdgeData>;
export type StreetBezierEdgeModel = Edge<Record<string, unknown>>;

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

function pointAt(x: number, y: number, direction: UnitVector, distance: number) {
  return {
    x: x + direction.x * distance,
    y: y + direction.y * distance,
  };
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

export function StreetBezierEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  interactionWidth,
  style,
}: EdgeProps<StreetBezierEdgeModel>) {
  const [path] = getStreetBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth ?? 0}
      style={style}
    />
  );
}

/**
 * A Bezier edge with a stable HTML label. React Flow's built-in edge
 * labels measure SVG text before showing it, which can flicker when
 * visible edges remount during pan/zoom. This renderer places the
 * label directly at the path midpoint instead.
 */
export function StableLabeledBezierEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  interactionWidth,
  data,
  style,
}: EdgeProps<StableLabeledEdgeModel>) {
  const [path, labelX, labelY] = getStreetBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const label = typeof data?.label === "string" ? data.label.trim() : "";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth ?? 0}
        style={style}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={data?.labelBoxClassName}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              zIndex: data?.labelZIndex ?? 0,
              pointerEvents: "none",
              opacity: data?.labelOpacity ?? 1,
              ...data?.labelBoxStyle,
            }}
          >
            <span className={data?.labelClassName} style={data?.labelStyle}>
              {label}
            </span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
