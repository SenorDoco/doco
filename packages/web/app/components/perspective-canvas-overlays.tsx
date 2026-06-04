import { ControlButton, Controls, type FitViewOptions } from "@xyflow/react";
import { Home, Maximize2, Minimize2 } from "lucide-react";
import { useFullscreenSpec } from "~/components/perspective-frame";

/**
 * Standard zoom controls. Top-right, offset 44px from the top so the
 * search box (which lives at top-right on the perspective host) sits
 * cleanly above. Fit-to-view and pan toggle are hidden — only
 * +/−/fit-view buttons render. Same in every perspective.
 *
 * `onHome`, when supplied, adds a 5th button beneath fullscreen that
 * resets the perspective to the view it opens on by default. Only the
 * perspectives that define a "home" view (Graph, BPMN) pass it; the rest
 * keep the four-button stack.
 *
 * Must be rendered INSIDE a `<ReactFlow>`.
 */
export function StandardControls({
  fitViewOptions,
  onHome,
}: { fitViewOptions?: FitViewOptions; onHome?: () => void } = {}) {
  // Fullscreen flows through context so every perspective gets the
  // same 4th button sitting flush below the +/-/fit-view stack
  // without each one threading the prop through manually.
  const fullscreen = useFullscreenSpec();
  return (
    <Controls
      position="top-right"
      showInteractive={false}
      fitViewOptions={fitViewOptions}
      style={{ top: 44 }}
    >
      {fullscreen ? (
        <ControlButton
          onClick={fullscreen.onToggle}
          title={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
          aria-label={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
        >
          {fullscreen.isFullscreen ? <Minimize2 /> : <Maximize2 />}
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
