import { type ReactNode, createContext, useContext } from "react";
import { cn } from "~/lib/cn";
import { lifecycleColor } from "~/lib/node-colors";

interface LifecycleFilterSpec {
  visible: Set<string>;
  available: Iterable<string>;
  onToggle: (lifecycle: string) => void;
  /**
   * Override the chip text for a stage. Lets a perspective relabel the generic
   * lifecycle stages into its own vocabulary — the Pull requests perspective
   * shows Open / Merged / Closed instead of queued / active / retired. Defaults
   * to the stage name with underscores spaced out.
   */
  labelFor?: (lifecycle: string) => string;
}

export interface FullscreenSpec {
  isFullscreen: boolean;
  onToggle: () => void;
}

/**
 * Carries the fullscreen toggle from PerspectiveFrame down into the
 * perspective's React-Flow `<StandardControls>` (which renders the
 * fullscreen ControlButton inline with the zoom +/−/fit-view stack).
 * Kept as a context so each perspective doesn't have to re-thread the
 * `isFullscreen` / `onToggle` props through to its zoom-controls
 * helper.
 */
const FullscreenContext = createContext<FullscreenSpec | null>(null);

export function useFullscreenSpec(): FullscreenSpec | null {
  return useContext(FullscreenContext);
}

interface PerspectiveFrameProps {
  fillHeight?: boolean;
  /**
   * Lifecycle visibility filter. Renders the floating bottom-left
   * panel ("Life cycle: ☑ active ☑ drafting …") inside the frame. The
   * perspective still receives `visibleLifecycles` so it can filter
   * its data accordingly; the frame just owns the UI.
   */
  lifecycleFilter?: LifecycleFilterSpec;
  /**
   * Fullscreen toggle. Surfaced as a 4th button in the perspective's
   * React-Flow zoom-controls stack (top-right), so it sits next to
   * +/−/fit-view inside the same morphic-styled panel — no overlap
   * with the floating search box and no ad-hoc placement per
   * perspective.
   */
  fullscreen?: FullscreenSpec;
  children: ReactNode;
}

/**
 * The canvas frame every perspective renders inside: a well sunk into the
 * page under the row of perspective tabs. The frame is owned by the
 * perspective HOST, not the perspectives themselves — perspectives are
 * content INSIDE the frame and must not draw their own edge, background,
 * or rounded corners. They also must not render their own lifecycle filter
 * or fullscreen button — those overlays live on the frame at fixed
 * positions so they're identical across Graph, BPMN, Org Tree, List, and
 * any future perspective.
 */
export function PerspectiveFrame({
  fillHeight = false,
  lifecycleFilter,
  fullscreen,
  children,
}: PerspectiveFrameProps) {
  const sizeClass = fillHeight ? "min-h-0 flex-1" : "h-[65vh] min-h-[480px]";
  return (
    <FullscreenContext.Provider value={fullscreen ?? null}>
      <div
        className={cn(
          "relative z-50 overflow-hidden rounded-lg bg-card text-card-foreground",
          sizeClass,
        )}
      >
        {/* `contain: layout paint` makes the perspective canvas its own
            rendering/compositing unit, so React Flow's per-frame DOM churn while
            panning stays inside this box instead of dragging the rest of the page
            (app shell, Señor Doco rail, side panel, frame chrome) into the
            browser's style/paint/composite pass every frame. This is what going
            fullscreen does implicitly — the canvas becomes the top-layer element
            and only it is rendered — which is why a fullscreened perspective pans
            noticeably smoother than the same one boxed inside the page. The box
            already clips via `overflow-hidden`, so paint containment changes
            nothing visually. */}
        <div className="relative z-0 h-full w-full overflow-hidden [contain:layout_paint]">
          {children}
        </div>
        {lifecycleFilter ? <LifecycleFilterPanel spec={lifecycleFilter} /> : null}
        {/* The well's inset shadow, painted over the canvas: on the frame itself
            it would sit under the perspective's own background. */}
        <div
          aria-hidden
          className="neu-well pointer-events-none absolute inset-0 z-[90] rounded-lg"
        />
      </div>
    </FullscreenContext.Provider>
  );
}

function LifecycleFilterPanel({ spec }: { spec: LifecycleFilterSpec }) {
  const available = Array.from(spec.available);
  if (available.length === 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10">
      <div className="neu-surface neu-small pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-card/90 px-2 py-1 text-xs backdrop-blur">
        <span className="text-muted-foreground">Life cycle:</span>
        {available.map((lifecycle) => {
          const checked = spec.visible.has(lifecycle);
          const color = lifecycleColor(lifecycle);
          const label = spec.labelFor ? spec.labelFor(lifecycle) : lifecycle.replaceAll("_", " ");
          return (
            <label
              key={lifecycle}
              className="inline-flex cursor-pointer select-none items-center gap-1"
              title={label}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => spec.onToggle(lifecycle)}
                className="h-3 w-3"
                style={{ accentColor: color }}
              />
              <span className="capitalize" style={{ color }}>
                {label}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
