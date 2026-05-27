import { BaseEdge, type Edge, type EdgeProps, getStraightPath } from "@xyflow/react";

export interface FadingPlaceholderEdgeData extends Record<string, unknown> {
  color: string;
  direction: "incoming" | "outgoing";
  opacity?: number;
  fadePx?: number;
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
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const color = data?.color ?? "#737373";
  const opacity = data?.opacity ?? 0.5;
  const fadePx = data?.fadePx ?? 100;
  const length = Math.max(1, Math.hypot(targetX - sourceX, targetY - sourceY));
  const fadePercent = Math.min(96, Math.max(8, (fadePx / length) * 100));
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
          x2={targetX}
          y2={targetY}
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
        path={path}
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
