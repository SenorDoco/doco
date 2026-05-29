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
  /** Columns this edge spans. When >= 2 the edge likely crosses an
   *  intermediate neuron, so the renderer bows it vertically to arc
   *  around them instead of cutting straight through. */
  bowSpan?: number;
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
  const bowSpan = typeof data?.bowSpan === "number" ? data.bowSpan : 0;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  // Forward edges that skip a column get bowed into the inter-row gap so
  // they arc over the neurons between their endpoints rather than cutting
  // straight through. U-turn loopbacks (target left of source) and short
  // edges fall through to bezierOrLoopPath, which already gives the
  // feedback loop its cusp-free apex and ordinary edges a plain bezier.
  const shouldBow = bowSpan >= 2 && dx > 24 && Math.abs(dy) < 56;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (shouldBow) {
    // Direction is chosen deterministically per edge so a bundle of long
    // edges fans up/down instead of stacking on a single arc. Magnitude
    // grows with the span but stays within roughly one inter-row gap.
    const lift = Math.min(84, 40 + bowSpan * 16) * edgeBowDirection(id);
    const c1x = sourceX + dx * 0.25;
    const c2x = sourceX + dx * 0.75;
    path = `M${sourceX},${sourceY} C${c1x},${sourceY + lift} ${c2x},${targetY + lift} ${targetX},${targetY}`;
    labelX = sourceX + dx / 2;
    labelY = (sourceY + targetY) / 2 + lift * 0.75;
  } else {
    [path, labelX, labelY] = bezierOrLoopPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }
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

/**
 * Stable up/down choice for an edge's vertical bow, derived from its id
 * so the same edge always bows the same way (no flicker on re-render)
 * while a bundle of edges still splits between arcing up and down.
 * Returns -1 (bow up, toward smaller y) or 1 (bow down).
 */
function edgeBowDirection(id: string): 1 | -1 {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return (hash & 1) === 0 ? -1 : 1;
}
