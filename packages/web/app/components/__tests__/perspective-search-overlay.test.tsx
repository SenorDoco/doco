import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PerspectiveFrame } from "../perspective-frame";
import { PerspectiveSearchOverlay } from "../perspective-search-overlay";

/** Resolve a Tailwind z-index utility (`z-50` or `z-[60]`) to its number. */
function zIndexOf(className: string): number {
  const arbitrary = className.match(/z-\[(\d+)\]/);
  if (arbitrary) return Number(arbitrary[1]);
  const scale = className.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
  if (scale) return Number(scale[1]);
  throw new Error(`no z-index utility found in className: ${className}`);
}

/** Class attribute of the static-markup element matching a distinctive token. */
function classWith(markup: string, token: string): string {
  const match = markup.match(new RegExp(`class="([^"]*${token}[^"]*)"`));
  if (!match) throw new Error(`no element matching ${token} in markup: ${markup}`);
  return match[1];
}

/**
 * The overlay renders a react-router `<Form>`, so it needs a router in scope —
 * same setup the nav-stacking test uses for the mobile popover.
 */
function renderOverlay(totalNodes: number): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(PerspectiveSearchOverlay, { handle: "acme", totalNodes }),
      },
    ],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("PerspectiveSearchOverlay", () => {
  it("labels the search with the live node count", () => {
    const markup = renderOverlay(12);
    expect(markup).toContain('name="q"');
    expect(markup).toContain("Search 12 nodes");
  });

  it("falls back to a generic label when the doco has no nodes yet", () => {
    expect(renderOverlay(0)).toContain("Search nodes");
  });

  it("stacks above the PerspectiveFrame so the opaque canvas can't bury it", () => {
    // The frame is an opaque `bg-card` sibling painted after the overlay; if
    // the overlay's z-index doesn't beat the frame's, the canvas hides the
    // search on every perspective. That's the regression this guards.
    const overlayZ = zIndexOf(classWith(renderOverlay(0), "pointer-events-none absolute"));

    const frameMarkup = renderToStaticMarkup(
      <PerspectiveFrame fillHeight>
        <div>canvas</div>
      </PerspectiveFrame>,
    );
    const frameZ = zIndexOf(classWith(frameMarkup, "relative z-"));

    expect(overlayZ).toBeGreaterThan(frameZ);
  });
});
