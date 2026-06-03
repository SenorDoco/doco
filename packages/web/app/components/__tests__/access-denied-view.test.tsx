import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { type AccessDeniedData, AccessDeniedView } from "../access-denied-view";

vi.mock("~/components/doco-mark", () => ({
  DocoMark: () => createElement("span", null, "Doco"),
}));

vi.mock("~/components/version-pill", () => ({
  VersionPill: () => null,
}));

function render(data: AccessDeniedData, currentPath = "/acme/secret"): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(AccessDeniedView, { data, currentPath }),
      },
    ],
    { initialEntries: [currentPath] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

const base: Omit<AccessDeniedData, "signed_in"> = {
  kind: "access_denied",
  doco_handle: "acme/secret",
  owner_slug: "acme",
};

describe("AccessDeniedView", () => {
  it("renders the private-doco card and a sign-in prompt for signed-out visitors", () => {
    const markup = render({ ...base, signed_in: false });

    expect(markup).toContain("Private doco");
    expect(markup).toContain("acme/secret");
    expect(markup).toContain("Sign in to continue.");
    expect(markup).toContain("/sign-in?next=");
  });

  it("offers an access request to signed-in visitors", () => {
    const markup = render({ ...base, signed_in: true });

    expect(markup).toContain("Private doco");
    expect(markup).toContain("Request access");
    expect(markup).toContain("request it from an owner");
  });

  it("does not pitch the AI-agent self-service block", () => {
    const signedOut = render({ ...base, signed_in: false });
    const signedIn = render({ ...base, signed_in: true });

    for (const markup of [signedOut, signedIn]) {
      expect(markup).not.toContain("Are you an AI agent?");
      expect(markup).not.toContain("waiting for a human invite");
      expect(markup).not.toContain("Connector clients");
      expect(markup).not.toContain("CLI / repo agents");
    }
  });
});
