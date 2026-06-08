import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, useStore } from "@xyflow/react";
import type { CSSProperties } from "react";
import { processSimplifiedAtZoom } from "~/lib/process-lod";
import { getStableEdgePath } from "./stable-labeled-edge-geometry";

// Marker class for a React Flow edge model that should read as clickable.
//
// React Flow only paints the pointer cursor for `.selectable` edges (base.css
// `.react-flow__edge.selectable { cursor: pointer }`), and we set
// `selectable: false` to keep its selection behavior off. An inline `cursor`
// on the edge `style` doesn't help either: `BaseEdge` applies that style to
// the visible `.react-flow__edge-path`, but layers a wider transparent
// `.react-flow__edge-interaction` path on top to catch the hover — so the
// cursor on the visible stroke is never seen. Clickable edges instead carry
// this class, and app.css sets the cursor on the edge group, which inherits
// down to the interaction path. This mirrors React Flow's own `.selectable`
// shape without opting into selection.
export const CLICKABLE_EDGE_CLASS = "doco-clickable-edge";

export function clickableEdgeClassName(clickable: boolean, base?: string): string | undefined {
  if (!clickable) return base;
  return base ? `${base} ${CLICKABLE_EDGE_CLASS}` : CLICKABLE_EDGE_CLASS;
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

/**
 * A process edge with a stable HTML label. The path is chosen by
 * getStableEdgePath (bezier forward, smoothstep for backward loops).
 * React Flow's built-in edge labels measure SVG text before showing it,
 * which can flicker when visible edges remount during pan/zoom; this
 * renderer places the label directly at the path midpoint instead.
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
  const [path, labelX, labelY] = getStableEdgePath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    bowDir: data?.bowDir,
    bowLift: data?.bowLift,
  });
  const rawLabel = typeof data?.label === "string" ? data.label.trim() : "";
  // Edge labels are HTML portaled into the canvas; at low zoom they're
  // illegible but still cost layout/paint on every pan frame. Drop them
  // with the rest of the node detail once zoomed out (same threshold as
  // the shapes). Selecting on the boolean keeps re-renders to the single
  // frame that crosses the threshold.
  const simplified = useStore((s) => processSimplifiedAtZoom(s.transform[2]));
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
