import { Maximize2, Minimize2 } from "lucide-react";
import type { ReactNode } from "react";
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

interface FullscreenSpec {
  isFullscreen: boolean;
  onToggle: () => void;
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
   * "Reorder automatically" toggle. Renders a checkbox in the same
   * bottom-left stack, just above the lifecycle row. The perspective
   * still receives `autoReorder` if it cares about it (Graph re-runs
   * its ring layout; other perspectives may ignore it). The toggle is
   * present on every perspective for consistency.
   */
  autoReorder?: AutoReorderSpec;
  /**
   * Fullscreen toggle button. Renders at top-right of the frame.
   * The caller owns the actual fullscreen request — the button is
   * just the trigger.
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
 * `rounded-tl-none` keeps the top-left corner square so the active
 * perspective tab visually flows into the canvas.
 */
export function PerspectiveFrame({
  fillHeight = false,
  lifecycleFilter,
  autoReorder,
  fullscreen,
  children,
}: PerspectiveFrameProps) {
  const sizeClass = fillHeight ? "min-h-0 flex-1" : "h-[65vh] min-h-[480px]";
  return (
    <div
      className={`relative w-full overflow-hidden rounded-md rounded-tl-none border border-border bg-background ${sizeClass}`}
    >
      {children}
      {fullscreen ? (
        <button
          type="button"
          onClick={fullscreen.onToggle}
          className="absolute right-2 top-2 z-20 rounded-md border border-border bg-background/90 p-1.5 shadow-sm backdrop-blur hover:bg-muted"
          title={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
          aria-label={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
        >
          {fullscreen.isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      ) : null}
      {autoReorder ? (
        <div className="pointer-events-none absolute bottom-12 left-3 z-10">
          <div className="pointer-events-auto rounded-md border border-border bg-card/90 px-2 py-1 shadow-sm backdrop-blur">
            <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px]">
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
