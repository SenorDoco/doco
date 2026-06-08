// Pure geometry for the BPMN canvas's sticky overlays — the swim-lane label
// rails pinned to the left edge and the pool-header band pinned to the top.
//
// These are the per-frame decisions (canvas-space geometry × the live React
// Flow viewport) that used to live inline in the perspective body. Extracting
// them does two things: it makes the math unit-testable, and it lets a small
// store-subscribed child (`ProcessCanvasOverlays`) own the pan re-render — so
// panning no longer re-renders the whole perspective (which holds <ReactFlow>).

export interface OverlayViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Where a swim lane's sticky rail should sit, or null when the lane is fully
 * off-screen (it then draws no rail). `laneY`/`laneHeight` are canvas-space; the
 * result is screen-space, clamped so a partially-visible lane's rail stays
 * within the canvas and never shrinks below `minRailHeight`.
 */
export function laneRailGeometry(
  laneY: number,
  laneHeight: number,
  viewport: OverlayViewport,
  canvasHeight: number,
  minRailHeight = 44,
): { top: number; height: number } | null {
  const laneTop = laneY * viewport.zoom + viewport.y;
  const laneBottom = (laneY + laneHeight) * viewport.zoom + viewport.y;
  if (laneBottom <= 0 || laneTop >= canvasHeight) return null;
  const visibleTop = Math.max(0, laneTop);
  const visibleBottom = Math.min(canvasHeight, laneBottom);
  const railHeight = Math.max(minRailHeight, visibleBottom - visibleTop);
  const top = Math.min(Math.max(0, visibleTop), Math.max(0, canvasHeight - railHeight));
  return { top, height: railHeight };
}

/**
 * Whether the sticky rail LABELS should show: only while the in-canvas lane
 * label has panned out past the rail's right edge (otherwise the label reads
 * twice) AND the canvas isn't simplified (below the LOD threshold the in-canvas
 * labels drop, so the rail labels must too). `inCanvasLabelOffset` is the
 * canvas-x of the in-canvas label's right edge (LANE_LEFT_INSET +
 * LANE_LABEL_WIDTH); `railWidth` is the rail strip's screen width.
 */
export function railLabelsVisible(
  viewport: OverlayViewport,
  inCanvasLabelOffset: number,
  railWidth: number,
  simplified: boolean,
): boolean {
  if (simplified) return false;
  const inCanvasLabelRightEdge = viewport.x + inCanvasLabelOffset * viewport.zoom;
  return inCanvasLabelRightEdge <= railWidth;
}

/**
 * Whether a pool's header should be pinned to the top as a sticky band: its
 * in-canvas header has scrolled above the top edge while the pool body is still
 * on screen. `poolY`/`poolHeight` are canvas-space; `poolRailHeight` is the
 * pinned band's screen height.
 */
export function stickyPoolPinned(
  poolY: number,
  poolHeight: number,
  viewport: OverlayViewport,
  canvasHeight: number,
  poolRailHeight: number,
): boolean {
  const poolTopScreen = poolY * viewport.zoom + viewport.y;
  const poolBottomScreen = (poolY + poolHeight) * viewport.zoom + viewport.y;
  const headerVisible = poolTopScreen >= 0;
  const poolOnScreen = poolBottomScreen > poolRailHeight && poolTopScreen < canvasHeight;
  return !headerVisible && poolOnScreen;
}
