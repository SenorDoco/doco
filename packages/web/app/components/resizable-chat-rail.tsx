// Resizable wrapper for the Doco-wide chat rail. Owns the rail width
// state, the drag handle, and the localStorage persistence so the route
// shell stays focused on the page composition.
//
// Width is clamped to [MIN_PX, viewport * MAX_RATIO]. The first paint uses
// a sensible default (1/4 viewport, floored at MIN_PX) so SSR markup stays
// stable; once the component mounts on the client we hydrate the saved
// preference and any subsequent drag updates it.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "doco.senorDoco.chatRailWidth";
const MIN_PX = 280;
const MAX_RATIO = 0.55;
const DEFAULT_RATIO = 0.28;

function computeDefaultWidth(viewportWidth: number): number {
  if (viewportWidth <= 0) return MIN_PX;
  return Math.max(MIN_PX, Math.min(viewportWidth * DEFAULT_RATIO, viewportWidth * MAX_RATIO));
}

function clampWidth(raw: number, viewportWidth: number): number {
  const ceiling = Math.max(MIN_PX, viewportWidth * MAX_RATIO);
  return Math.max(MIN_PX, Math.min(raw, ceiling));
}

interface ResizableChatRailProps {
  children: ReactNode;
}

export function ResizableChatRail({ children }: ResizableChatRailProps) {
  // SSR-stable initial: don't read window. Hydrate on mount.
  const [width, setWidth] = useState<number>(MIN_PX);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const viewport = window.innerWidth;
    let initial = computeDefaultWidth(viewport);
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = Number.parseFloat(stored);
        if (Number.isFinite(parsed)) initial = clampWidth(parsed, viewport);
      }
    } catch {
      // localStorage unavailable (Safari private mode etc.) — fall through.
    }
    setWidth(initial);
  }, []);

  useEffect(() => {
    function onResize() {
      setWidth((prev) => clampWidth(prev, window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setDragging(true);

    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - startX;
      setWidth(clampWidth(startWidth + delta, window.innerWidth));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDragging(false);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      } catch {
        // Swallow — persistence is a nice-to-have.
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <>
      <aside className="flex shrink-0 flex-col border-r border-border bg-card" style={{ width }}>
        {children}
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat rail"
        tabIndex={0}
        onMouseDown={startDrag}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const step = e.shiftKey ? 48 : 16;
          const delta = e.key === "ArrowLeft" ? -step : step;
          const next = clampWidth(widthRef.current + delta, window.innerWidth);
          setWidth(next);
          try {
            window.localStorage.setItem(STORAGE_KEY, String(next));
          } catch {
            // ignored
          }
        }}
        className={
          dragging
            ? "w-1.5 shrink-0 cursor-col-resize bg-primary/40 outline-none"
            : "w-1.5 shrink-0 cursor-col-resize bg-border outline-none transition-colors hover:bg-primary/40 focus-visible:bg-primary/40"
        }
      />
    </>
  );
}
