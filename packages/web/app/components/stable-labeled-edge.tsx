import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Position,
  getBezierPath,
  useStore,
} from "@xyflow/react";
import type { CSSProperties } from "react";
import { bpmnSimplifiedAtZoom } from "~/lib/bpmn-lod";

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
  /** Vertical bow applied when a node blocks this edge's straight path.
   *  `bowLift` is the cubic control-point offset in px; `bowDir` is -1 to
   *  arc up (toward smaller y) or 1 to arc down. Both are set by the
   *  layout (which knows node geometry); absent means render straight. */
  bowDir?: 1 | -1;
  bowLift?: number;
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
  const bowLift = typeof data?.bowLift === "number" ? data.bowLift : 0;
  const bowDir = data?.bowDir === 1 ? 1 : -1;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  // The layout sets bowLift/bowDir only when a node actually blocks the
  // edge's straight path (and which way to arc around it); here we just
  // apply that vertical lift so the edge bows over/under the obstacle.
  // U-turn loopbacks and unblocked edges keep bezierOrLoopPath.
  const shouldBow = bowLift > 0 && dx > 24 && Math.abs(dy) < 80;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (shouldBow) {
    const lift = bowLift * bowDir;
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
  const rawLabel = typeof data?.label === "string" ? data.label.trim() : "";
  // Edge labels are HTML portaled into the canvas; at low zoom they're
  // illegible but still cost layout/paint on every pan frame. Drop them
  // with the rest of the node detail once zoomed out (same threshold as
  // the shapes). Selecting on the boolean keeps re-renders to the single
  // frame that crosses the threshold.
  const simplified = useStore((s) => bpmnSimplifiedAtZoom(s.transform[2]));
  const label = simplified ? "" : rawLabel;

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
