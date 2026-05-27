import { BaseEdge, type Edge, type EdgeProps, useViewport } from "@xyflow/react";
import { getFadingPlaceholderGeometry } from "./fading-placeholder-edge-geometry";

export interface FadingPlaceholderEdgeData extends Record<string, unknown> {
  color: string;
  direction: "incoming" | "outgoing";
  opacity?: number;
  fadePx?: number;
  markerClearancePx?: number;
}

export type FadingPlaceholderEdgeModel = Edge<FadingPlaceholderEdgeData>;

function gradientIdFor(edgeId: string): string {
  return `placeholder-gradient-${edgeId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function FadingPlaceholderEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  interactionWidth,
  data,
  style,
}: EdgeProps<FadingPlaceholderEdgeModel>) {
  const { zoom } = useViewport();
  const markerClearance =
    data?.markerClearancePx && zoom > 0 ? Math.max(0, data.markerClearancePx) / zoom : 0;
  const geometry = getFadingPlaceholderGeometry({
    sourceX,
    sourceY,
    targetX,
    targetY,
    direction: data?.direction,
    hasMarkerEnd: Boolean(markerEnd),
    markerClearance,
  });
  const color = data?.color ?? "#737373";
  const opacity = data?.opacity ?? 0.5;
  const fadePx = data?.fadePx ?? 100;
  const fadePercent = Math.min(96, Math.max(8, (fadePx / geometry.length) * 100));
  const gradientId = gradientIdFor(id);
  const isOutgoing = data?.direction !== "incoming";
  const stops = isOutgoing
    ? [
        { offset: "0%", opacity },
        { offset: `${fadePercent}%`, opacity: 0 },
        { offset: "100%", opacity: 0 },
      ]
    : [
        { offset: "0%", opacity: 0 },
        { offset: `${100 - fadePercent}%`, opacity: 0 },
        { offset: "100%", opacity },
      ];

  return (
    <>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={geometry.endX}
          y2={geometry.endY}
        >
          {stops.map((stop) => (
            <stop
              key={`${stop.offset}-${stop.opacity}`}
              offset={stop.offset}
              stopColor={color}
              stopOpacity={stop.opacity}
            />
          ))}
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={geometry.path}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth ?? 0}
        style={{
          ...style,
          stroke: `url(#${gradientId})`,
          strokeLinecap: "round",
          strokeOpacity: 1,
          strokeWidth: 1.75,
        }}
      />
    </>
  );
}
