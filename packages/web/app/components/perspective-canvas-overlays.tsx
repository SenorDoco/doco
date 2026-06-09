import { ControlButton, Controls, type FitViewOptions, useReactFlow } from "@xyflow/react";
import { Home, Maximize, Maximize2, Minimize } from "lucide-react";
import { useFullscreenSpec } from "~/components/perspective-frame";

/**
 * Standard zoom controls. Top-right, offset 44px from the top so the
 * search box (top-right on the perspective host) clears them. The pan
 * toggle is hidden, and React Flow's built-in fit-view is replaced by
 * our own button so it can wear an intentional icon instead of the
 * library default. Top to bottom: +/− zoom, fit-to-view (diagonal
 * arrows ⤢), then full screen (corner-bracket frame ⛶) — distinct
 * glyphs so the two never read as the same action. Same in every
 * perspective.
 *
 * `onHome`, when supplied, adds a button beneath full screen that resets
 * the perspective to the view it opens on by default. Only the
 * perspectives that define a "home" view (Graph, BPMN) pass it; the rest
 * keep the shorter stack.
 *
 * Must be rendered INSIDE a `<ReactFlow>` — it reads the flow instance to
 * drive fit-to-view.
 */
export function StandardControls({
  fitViewOptions,
  onHome,
}: { fitViewOptions?: FitViewOptions; onHome?: () => void } = {}) {
  // Fullscreen flows through context so every perspective gets the same
  // full-screen button below the +/−/fit-view stack without each one
  // threading the prop through manually.
  const fullscreen = useFullscreenSpec();
  const { fitView } = useReactFlow();
  return (
    <Controls position="top-right" showInteractive={false} showFitView={false} style={{ top: 44 }}>
      <ControlButton
        onClick={() => fitView(fitViewOptions)}
        title="Fit to view"
        aria-label="Fit to view"
      >
        <Maximize2 />
      </ControlButton>
      {fullscreen ? (
        <ControlButton
          onClick={fullscreen.onToggle}
          title={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
          aria-label={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
        >
          {fullscreen.isFullscreen ? <Minimize /> : <Maximize />}
        </ControlButton>
      ) : null}
      {onHome ? (
        <ControlButton
          onClick={onHome}
          title="Reset to default view"
          aria-label="Reset to default view"
        >
          <Home />
        </ControlButton>
      ) : null}
    </Controls>
  );
}
