import { type RefObject, useCallback, useEffect, useState } from "react";

interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

function currentFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Drive an HTMLElement in and out of native browser fullscreen, with
 * a Safari prefix fallback. Calling toggle() outside a user gesture
 * is a no-op in most browsers — wire it to a click handler.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>): {
  isFullscreen: boolean;
  toggle: () => void;
} {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const update = () => setIsFullscreen(currentFullscreenElement() === ref.current);
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    update();
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, [ref]);

  const toggle = useCallback(() => {
    const el = ref.current as FullscreenElement | null;
    if (!el) return;
    const active = currentFullscreenElement();
    if (active === el) {
      const doc = document as FullscreenDocument;
      const exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
      if (exit) void exit();
      return;
    }
    const request = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (request) void request();
  }, [ref]);

  return { isFullscreen, toggle };
}
