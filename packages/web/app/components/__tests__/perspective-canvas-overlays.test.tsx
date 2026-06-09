import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// `StandardControls` renders inside a `<ReactFlow>`, so its xyflow imports
// need the flow context. Stub them: `Controls`/`ControlButton` become plain
// wrappers that surface the title/aria-label/icon to the markup, and
// `useReactFlow` hands back a `fitView` we can point the fit button at.
vi.mock("@xyflow/react", () => ({
  Controls: ({ children }: { children?: unknown }) =>
    createElement("div", { "data-controls": "" }, children as never),
  ControlButton: ({
    children,
    onClick,
    title,
    "aria-label": ariaLabel,
  }: {
    children?: unknown;
    onClick?: () => void;
    title?: string;
    "aria-label"?: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick, title, "aria-label": ariaLabel },
      children as never,
    ),
  useReactFlow: () => ({ fitView: () => {} }),
}));

// The fullscreen toggle reaches `StandardControls` through context off the
// frame; feed it a spec we can flip between entered/exited per test.
const fullscreen = vi.hoisted(() => ({
  current: null as null | { isFullscreen: boolean; onToggle: () => void },
}));
vi.mock("~/components/perspective-frame", () => ({
  useFullscreenSpec: () => fullscreen.current,
}));

import { StandardControls } from "~/components/perspective-canvas-overlays";

// Each control's icon is the first lucide `<svg>` after its aria-label, so
// reading the class right after the label tells us which glyph it wears.
function iconClassFor(html: string, ariaLabel: string): string {
  const at = html.indexOf(`aria-label="${ariaLabel}"`);
  if (at === -1) return "";
  const m = html.slice(at).match(/class="(lucide[^"]*)"/);
  return m ? m[1] : "";
}

describe("StandardControls icons", () => {
  it("full screen wears the corner-bracket frame, not the diagonal arrows", () => {
    fullscreen.current = { isFullscreen: false, onToggle: () => {} };
    const html = renderToStaticMarkup(createElement(StandardControls));
    // Maximize = the four-corner-bracket frame (⛶), the universal
    // full-screen glyph; Maximize2 = diagonal arrows, which read as "fit".
    expect(iconClassFor(html, "Enter full screen")).toContain("lucide-maximize");
    expect(iconClassFor(html, "Enter full screen")).not.toContain("maximize2");
  });

  it("exiting full screen wears the inward corner brackets", () => {
    fullscreen.current = { isFullscreen: true, onToggle: () => {} };
    const html = renderToStaticMarkup(createElement(StandardControls));
    expect(iconClassFor(html, "Exit full screen")).toContain("lucide-minimize");
    expect(iconClassFor(html, "Exit full screen")).not.toContain("minimize2");
  });

  it("fit to view is its own button wearing the diagonal arrows", () => {
    fullscreen.current = { isFullscreen: false, onToggle: () => {} };
    const html = renderToStaticMarkup(createElement(StandardControls));
    expect(html).toContain('aria-label="Fit to view"');
    expect(iconClassFor(html, "Fit to view")).toContain("lucide-maximize2");
  });

  it("fit to view and full screen never share a glyph", () => {
    fullscreen.current = { isFullscreen: false, onToggle: () => {} };
    const html = renderToStaticMarkup(createElement(StandardControls));
    expect(iconClassFor(html, "Fit to view")).not.toEqual(iconClassFor(html, "Enter full screen"));
  });
});
