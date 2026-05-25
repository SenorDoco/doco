import type { ReactNode } from "react";

interface PerspectiveFrameProps {
  fillHeight?: boolean;
  children: ReactNode;
}

/**
 * The bordered canvas frame every perspective renders inside. The
 * frame is owned by the perspective HOST, not the perspectives
 * themselves — perspectives are content INSIDE the frame and must not
 * draw their own border, background, or rounded corners. Keeps Graph /
 * BPMN / Org Tree / future perspectives visually consistent without
 * each one re-implementing the chrome (and drifting, as Org Tree did
 * when it shipped with a default-colored border instead of
 * border-border).
 *
 * `rounded-tl-none` keeps the top-left corner square so the active
 * perspective tab visually flows into the canvas.
 */
export function PerspectiveFrame({ fillHeight = false, children }: PerspectiveFrameProps) {
  const sizeClass = fillHeight ? "min-h-0 flex-1" : "h-[65vh] min-h-[480px]";
  return (
    <div
      className={`relative w-full overflow-hidden rounded-md rounded-tl-none border border-border bg-background ${sizeClass}`}
    >
      {children}
    </div>
  );
}
