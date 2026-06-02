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
