import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SiteHeader } from "../site-header";
import { DOCO_TAGLINE, VersionPill } from "../version-pill";

vi.mock("~/components/doco-mark", () => ({
  DocoMark: () => createElement("span", null, "Doco"),
}));

beforeAll(() => {
  // VersionPill reads these vite-injected build-time globals during render.
  vi.stubGlobal("__DOCO_VERSION__", "0.0.0-test");
  vi.stubGlobal("__DOCO_RELEASE_AT__", "2026-01-01T00:00:00.000Z");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function render(element: React.ReactElement): string {
  const router = createMemoryRouter([{ path: "*", element }], { initialEntries: ["/"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

function classOf(markup: string, pattern: RegExp): string {
  const match = markup.match(pattern);
  if (!match) throw new Error(`no element matching ${pattern} in markup: ${markup}`);
  return match[1];
}

/**
 * The signed-in header is one fixed-height row: logo and version strip on the
 * left, nav on the right. Nothing in it may paint over anything else, at any
 * width (an owner's nav with Feedback, Access requests and the feedback flags
 * is ~860px wide; at 1081px the tagline used to run under "Workspaces").
 */
describe("SiteHeader fits its row", () => {
  it("keeps the nav in the menu until the row has room for every button (xl)", () => {
    const markup = render(
      createElement(SiteHeader, {
        me: { id: "user_alice", username: "alice", type: "person", isHuman: true },
      }),
    );

    const inlineNav = classOf(markup, /<nav class="([^"]*)"/);
    expect(inlineNav).toMatch(/(?:^|\s)hidden(?:\s|$)/);
    expect(inlineNav).toMatch(/(?:^|\s)xl:flex(?:\s|$)/);
    expect(inlineNav).not.toMatch(/(?:^|\s)lg:flex(?:\s|$)/);

    const menu = classOf(
      markup,
      /<div class="([^"]*)"><button[^>]*aria-label="Open navigation menu"/,
    );
    expect(menu).toMatch(/(?:^|\s)xl:hidden(?:\s|$)/);
    expect(menu).not.toMatch(/(?:^|\s)lg:hidden(?:\s|$)/);
  });

  it("lets the version strip shrink instead of overflowing its neighbours", () => {
    const markup = render(createElement(VersionPill));

    const strip = classOf(markup, /^<span class="([^"]*)"/);
    expect(strip).toMatch(/(?:^|\s)min-w-0(?:\s|$)/);

    // The version line ends in an ellipsis rather than running on.
    const version = classOf(markup, /<span class="([^"]*)">Alpha /);
    expect(version).toMatch(/(?:^|\s)truncate(?:\s|$)/);

    // The strip's tagline is the product's longer line; the home page carries
    // the shorter headline.
    expect(markup).toContain(">Shared knowledge and context for AI and teams</span>");

    // The tagline wraps onto at most two balanced lines (both fit the 56px row
    // under the version line) rather than staying on one line that can't fit.
    const tagline = classOf(markup, new RegExp(`<span class="([^"]*)">${DOCO_TAGLINE}<`));
    expect(tagline).toMatch(/(?:^|\s)sm:line-clamp-2(?:\s|$)/);
    expect(tagline).toMatch(/(?:^|\s)text-balance(?:\s|$)/);
    expect(tagline).not.toMatch(/whitespace-nowrap/);
  });

  // Set in Merriweather, an owner's full nav (Access requests, Feedback and the
  // flags) at 1280px clipped the tagline's second line with gap-3 and px-3
  // buttons; gap-2 and px-2.5 leave both tagline lines and the version line
  // whole (measured in Chromium).
  it("spaces the inline nav tightly enough for an owner's nav at 1280px", () => {
    const markup = render(
      createElement(SiteHeader, {
        me: { id: "user_alice", username: "alice", type: "person", isHuman: true },
      }),
    );

    const inlineNav = classOf(markup, /<nav class="([^"]*)"/);
    expect(inlineNav).toMatch(/(?:^|\s)gap-2(?:\s|$)/);

    const workspaces = classOf(markup, /<nav class="[^"]*"><a[^>]*class="([^"]*)"/);
    expect(workspaces).toMatch(/(?:^|\s)px-2\.5(?:\s|$)/);
  });
});
