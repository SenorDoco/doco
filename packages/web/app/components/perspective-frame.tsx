import { type ReactNode, createContext, useContext } from "react";
import { cn } from "~/lib/cn";
import { lifecycleColor } from "~/lib/neuron-colors";

interface LifecycleFilterSpec {
  visible: Set<string>;
  available: Iterable<string>;
  onToggle: (lifecycle: string) => void;
}

interface AutoReorderSpec {
  value: boolean;
  onChange: (next: boolean) => void;
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
   * "Reorder automatically" toggle. Renders a checkbox in the same
   * bottom-left stack, just above the lifecycle row. The perspective
   * still receives `autoReorder` if it cares about it (Graph re-runs
   * its ring layout; other perspectives may ignore it). The toggle is
   * present on every perspective for consistency.
   */
  autoReorder?: AutoReorderSpec;
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
 * must not render their own lifecycle filter, autoreorder toggle, or
 * fullscreen button — those overlays live on the frame at fixed
 * positions so they're identical across Graph, BPMN, Org Tree, List,
 * and any future perspective.
 *
 * The frame keeps the same etched border as other Doco sections. Tabs
 * overlap its top edge: inactive tabs sit underneath the frame border,
 * while the active tab renders above the border to own the selected join.
 */
export function PerspectiveFrame({
  fillHeight = false,
  rightTabAttached = false,
  lifecycleFilter,
  autoReorder,
  fullscreen,
  children,
}: PerspectiveFrameProps) {
  const sizeClass = fillHeight ? "min-h-0 flex-1" : "h-[65vh] min-h-[480px]";
  return (
    <FullscreenContext.Provider value={fullscreen ?? null}>
      <div
        className={cn(
          "neu-surface relative z-50 -mt-px w-full overflow-hidden rounded-b-lg rounded-tl-none border border-border bg-card text-card-foreground",
          rightTabAttached ? "!rounded-tr-none" : "rounded-tr-lg",
          sizeClass,
        )}
        style={rightTabAttached ? { borderTopRightRadius: 0 } : undefined}
      >
        {children}
        {autoReorder ? (
          <div className="pointer-events-none absolute bottom-12 left-3 z-10">
            {/* Match the LifecycleFilterPanel's outer structure exactly
              so the two floating panels render at identical height:
              flex items-center + px-2 py-1 + text-xs. Diverging on any
              of those (e.g. text-[11px] or no flex on outer) makes the
              Reorder pill render a pixel or two taller than the filter
              row immediately below it. */}
            <div className="pointer-events-auto flex items-center rounded-md border border-border bg-card/90 px-2 py-1 text-xs shadow-sm backdrop-blur">
              <label className="inline-flex cursor-pointer select-none items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={autoReorder.value}
                  onChange={(e) => autoReorder.onChange(e.target.checked)}
                  className="h-3 w-3"
                />
                <span className="text-muted-foreground">Reorder automatically</span>
              </label>
            </div>
          </div>
        ) : null}
        {lifecycleFilter ? <LifecycleFilterPanel spec={lifecycleFilter} /> : null}
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
          return (
            <label
              key={lifecycle}
              className="inline-flex cursor-pointer select-none items-center gap-1"
              title={lifecycle}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => spec.onToggle(lifecycle)}
                className="h-3 w-3"
                style={{ accentColor: color }}
              />
              <span className="capitalize" style={{ color }}>
                {lifecycle.replaceAll("_", " ")}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
