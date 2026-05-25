import { Controls, type FitViewOptions, MiniMap, type MiniMapNodeProps } from "@xyflow/react";
import type { ComponentType } from "react";

const MINIMAP_STYLE = {
  width: 140,
  height: 100,
  background: "var(--color-background)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
} as const;

/**
 * Standard minimap for every React-Flow-based perspective. The size,
 * background, border, and mask colour are fixed by the renderer —
 * perspectives can only customise the per-node rendering via
 * `nodeComponent` (so a BPMN circle renders as a small dot, an Intent
 * card renders in its lifecycle colour, etc.). Keeps the minimap a
 * consistent 140×100 box in the bottom-right of every perspective.
 *
 * Must be rendered INSIDE a `<ReactFlow>` because it pulls viewport
 * state from React Flow's context.
 */
export function StandardMiniMap({
  nodeComponent,
}: {
  nodeComponent?: ComponentType<MiniMapNodeProps>;
}) {
  return (
    <MiniMap
      pannable
      zoomable
      maskColor="rgba(0, 0, 0, 0.35)"
      nodeComponent={nodeComponent}
      nodeStrokeWidth={1}
      style={MINIMAP_STYLE}
    />
  );
}

/**
 * Standard zoom controls. Top-right, offset 44px from the top so the
 * search box (which lives at top-right on the perspective host) sits
 * cleanly above. Fit-to-view and pan toggle are hidden — only
 * +/−/fit-view buttons render. Same in every perspective.
 *
 * Must be rendered INSIDE a `<ReactFlow>`.
 */
export function StandardControls({ fitViewOptions }: { fitViewOptions?: FitViewOptions } = {}) {
  return (
    <Controls
      position="top-right"
      showInteractive={false}
      fitViewOptions={fitViewOptions}
      style={{ top: 44 }}
    />
  );
}
