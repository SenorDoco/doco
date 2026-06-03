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
   * A tab can attach to the frame's right edge; when it does, the
   * frame's top-right corner must flatten just like the top-left.
   */
  rightTabAttached?: boolean;
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
 * The bordered canvas frame every perspective renders inside. The
 * frame is owned by the perspective HOST, not the perspectives
 * themselves — perspectives are content INSIDE the frame and must not
 * draw their own border, background, or rounded corners. They also
 * must not render their own lifecycle filter or fullscreen button —
 * those overlays live on the frame at fixed positions so they're
 * identical across Graph, BPMN, Org Tree, List, and any future
 * perspective.
 *
 * The frame keeps the same etched border as other Doco sections. Tabs
 * overlap its top edge: inactive tabs sit underneath the frame border,
 * while the active tab renders above the border to own the selected join.
 */
export function PerspectiveFrame({
  fillHeight = false,
  rightTabAttached = false,
  lifecycleFilter,
  fullscreen,
  children,
}: PerspectiveFrameProps) {
  const sizeClass = fillHeight ? "min-h-0 flex-1" : "h-[calc(65vh+2px)] min-h-[482px]";
  const frameRadiusClass = rightTabAttached ? "!rounded-tr-none" : "rounded-tr-lg";
  const frameRadiusStyle = rightTabAttached ? { borderTopRightRadius: 0 } : undefined;
  return (
    <FullscreenContext.Provider value={fullscreen ?? null}>
      <div
        className={cn(
          "relative z-50 -m-px w-[calc(100%+2px)] overflow-hidden rounded-b-lg rounded-tl-none border border-transparent bg-card text-card-foreground",
          frameRadiusClass,
          sizeClass,
        )}
        style={frameRadiusStyle}
      >
        <div className="relative z-0 h-full w-full overflow-hidden">{children}</div>
        {lifecycleFilter ? <LifecycleFilterPanel spec={lifecycleFilter} /> : null}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-[80] overflow-hidden rounded-b-lg rounded-tl-none",
            frameRadiusClass,
          )}
          style={frameRadiusStyle}
        >
          <div className="absolute left-0 right-0 top-0 h-0.5 bg-card" />
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-card" />
          <div className="absolute bottom-0 left-0 top-0 w-0.5 bg-card" />
          <div className="absolute bottom-0 right-0 top-0 w-0.5 bg-card" />
        </div>
        <div
          aria-hidden
          className={cn(
            "neu-surface pointer-events-none absolute inset-0 z-[90] rounded-b-lg rounded-tl-none border border-border",
            frameRadiusClass,
          )}
          style={frameRadiusStyle}
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
      <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/90 px-2 py-1 text-xs shadow-sm backdrop-blur">
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
