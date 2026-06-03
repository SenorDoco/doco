import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { MobileNavPanel } from "../site-header";

vi.mock("~/components/doco-mark", () => ({
  DocoMark: () => createElement("span", null, "Doco"),
}));

vi.mock("~/components/version-pill", () => ({
  VersionPill: () => null,
}));

/**
 * The doco page floats its node/edge detail dialog over the content at
 * `z-[100]` (see `app/routes/$docoHandle._index.tsx`). The header's mobile
 * nav popover and that dialog share the root stacking context — the shell
 * wrappers between them (`.doco-shell-body` etc.) set no z-index — so the
 * popover must outrank `z-[100]`, or the dialog paints over an open menu.
 */
const PAGE_CONTENT_DIALOG_Z = 100;

/** Resolve a Tailwind z-index utility (`z-50` or `z-[130]`) to its number. */
function zIndexOf(className: string): number {
  const arbitrary = className.match(/z-\[(\d+)\]/);
  if (arbitrary) return Number(arbitrary[1]);
  const scale = className.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
  if (scale) return Number(scale[1]);
  throw new Error(`no z-index utility found in className: ${className}`);
}

function renderPanelClass(): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(MobileNavPanel, {
          me: { id: "user_alice", username: "alice", type: "person", isHuman: true },
        }),
      },
    ],
    { initialEntries: ["/"] },
  );
  const markup = renderToStaticMarkup(createElement(RouterProvider, { router }));
  const match = markup.match(/class="([^"]*\bneu-floating\b[^"]*)"/);
  if (!match) throw new Error(`could not find the nav popover element in markup: ${markup}`);
  return match[1];
}

describe("SiteHeader mobile nav stacking", () => {
  it("stacks the popover above the page's z-[100] detail-dialog layer", () => {
    const panelClass = renderPanelClass();

    expect(zIndexOf(panelClass)).toBeGreaterThan(PAGE_CONTENT_DIALOG_Z);
  });
});
