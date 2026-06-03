import { useEffect, useState } from "react";

/**
 * Below this viewport width the signed-in shell stops seating Señor Doco
 * as an in-flow side rail and floats it over the page as an overlay
 * drawer. Keep in sync with the 640px breakpoint in `app.css`.
 */
export const SHELL_OVERLAY_MAX_WIDTH = "(max-width: 639.98px)";

/**
 * Whether the live "Thinking" column is active. It needs the wide (640px)
 * two-column rail, so it is only ever on in chat view, when the user
 * asked for it, and when the rail is a real side rail — never in the
 * narrow overlay drawer, where the toggle is hidden and the column can't
 * fit.
 */
export function resolveThinkingActive(opts: {
  showThinking: boolean;
  view: "chat" | "list";
  narrow: boolean;
}): boolean {
  return opts.showThinking && opts.view === "chat" && !opts.narrow;
}

/**
 * The width to publish as `--senor-doco-rail-width` for page content (the
 * node/edge dialog) to clear. The expanded narrow drawer is a modal
 * floating above the page, so it reserves nothing (0px) and the page spans
 * full width behind it. Everything else — the wide side rail and the narrow
 * collapsed 32px strip — reserves its real width so a fixed dialog doesn't
 * cover it (e.g. cover the only handle to reopen the chat).
 */
export function resolvePublishedRailWidth(opts: {
  narrow: boolean;
  collapsed: boolean;
  railWidth: string;
}): string {
  return opts.narrow && !opts.collapsed ? "0px" : opts.railWidth;
}

/**
 * Tracks whether the shell is below the overlay breakpoint. SSR can't
 * know the viewport width, so it starts at `false` (side rail) and
 * corrects on mount to avoid a hydration mismatch.
 */
export function useNarrowShell(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(SHELL_OVERLAY_MAX_WIDTH);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}
