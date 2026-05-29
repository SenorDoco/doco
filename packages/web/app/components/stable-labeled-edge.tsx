import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Position,
  getBezierPath,
} from "@xyflow/react";
import type { CSSProperties } from "react";

// A bezier has no corner radius, so when an edge doubles back — its
// target sitting to the left of its source, e.g. a gateway's feedback
// loop — the single cubic folds onto itself into a zero-radius cusp: the
// unreadable 180° spike. For those U-turns only, route through a vertical
// apex just to the right of the source so the path bows into a smooth
// loop whose turn radius stays well above 2px. Every ordinary left→right
// edge keeps React Flow's exact bezier untouched.
const UTURN_APEX_OUT = 32; // px the loop apex sits to the right of the source
const UTURN_MIN_BOW = 16; // px minimum vertical loop height (same-row U-turns)

function bezierOrLoopPath(p: {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
}): [path: string, labelX: number, labelY: number] {
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition } = p;
  const isUTurn =
    sourcePosition === Position.Right && targetPosition === Position.Left && targetX < sourceX;
  if (!isUTurn) {
    const [path, labelX, labelY] = getBezierPath(p);
    return [path, labelX, labelY];
  }
  const dir = targetY >= sourceY ? 1 : -1;
  const half = Math.max(UTURN_MIN_BOW, Math.abs(targetY - sourceY) / 2);
  const apexX = sourceX + UTURN_APEX_OUT;
  const apexY = sourceY + dir * half;
  // Two cubics meeting at the apex with matching vertical tangents (G1
  // continuity), so the junction stays smooth and never cusps.
  const [toApex] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX: apexX,
    targetY: apexY,
    targetPosition: dir > 0 ? Position.Top : Position.Bottom,
  });
  const [fromApex] = getBezierPath({
    sourceX: apexX,
    sourceY: apexY,
    sourcePosition: dir > 0 ? Position.Bottom : Position.Top,
    targetX,
    targetY,
    targetPosition: Position.Left,
  });
  // Drop the second segment's leading "M apexX,apexY" so it continues the
  // first subpath instead of restarting it. The apex doubles as the label
  // anchor — it's the loop's midpoint.
  return [`${toApex} ${fromApex.slice(fromApex.indexOf("C"))}`, apexX, apexY];
}

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
export type CurvedBezierEdgeModel = Edge<Record<string, unknown>>;

export function CurvedBezierEdge({
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
}: EdgeProps<CurvedBezierEdgeModel>) {
  const [path] = bezierOrLoopPath({
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
  const [path, labelX, labelY] = bezierOrLoopPath({
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
