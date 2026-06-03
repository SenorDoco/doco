import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SiteHeader } from "../site-header";

vi.mock("~/components/doco-mark", () => ({
  DocoMark: () => createElement("span", null, "Doco"),
}));

vi.mock("~/components/version-pill", () => ({
  VersionPill: () => null,
}));

function renderHeader(): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(SiteHeader, {
          me: { id: "user_alice", username: "alice", type: "person", isHuman: true },
        }),
      },
    ],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("SiteHeader copy", () => {
  it("uses the requested integration and token navigation labels", () => {
    const markup = renderHeader();

    expect(markup).toContain("App integrations");
    expect(markup).toContain("Tokens/MCP");
    expect(markup).not.toContain(">Integrations</a>");
    expect(markup).not.toContain(">Access tokens</a>");
    expect(markup).not.toContain(">Connect</a>");
    expect(markup).not.toContain('href="/connect"');
  });
});

describe("SiteHeader account menu", () => {
  it("renders the current user's handle with an @ prefix", () => {
    const markup = renderHeader();

    expect(markup).toContain(">@alice</a>");
    expect(markup).not.toContain(">alice</a>");
  });

  it("gives the account button square corners like the rest of the menu", () => {
    const markup = renderHeader();

    // The account link is the only place that used a pill shape; every menu
    // button should share the same `rounded-md` corners.
    expect(markup).not.toContain("rounded-full");
  });

  it("left-aligns the Sign out control like the other menu items", () => {
    const markup = renderHeader();

    // Sign out is the only <button> (the rest are anchors), so without an
    // explicit alignment it inherits the UA-default centered text and looks
    // out of line in the stacked mobile menu.
    expect(markup).toMatch(/<button[^>]*\btext-left\b[^>]*>Sign out<\/button>/);
  });
});
