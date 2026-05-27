import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import { getStreetBezierPath } from "./stable-labeled-edge-path";

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
