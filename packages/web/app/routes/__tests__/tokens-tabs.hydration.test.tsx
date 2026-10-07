// @vitest-environment happy-dom
//
// Reproduces the "tabs are not responding" report by exercising the real
// thing the browser does: render the page to HTML on the "server", hydrate
// that HTML in a DOM, then click a tab and assert the panel switches. A
// hydration error (mismatched markup, invalid nesting, a throw) would leave
// the tab strip inert here exactly as it does in the browser.
import { createElement } from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

// React's act() needs this flag to flush effects/state updates synchronously
// in a non-browser test runner; without it the warning fires and updates may
// not be applied before assertions.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import ApiKeysPage from "../tokens";

function App() {
  return createElement(
    MemoryRouter,
    null,
    createElement(ApiKeysPage, {
      loaderData: {
        keys: [],
        scopeOptions: [],
        host: "https://doco.test",
        justMinted: null,
      },
    }),
  );
}

describe("Tokens/MCP tabs hydrate and respond to clicks", () => {
  it("switches the panel when a tab is clicked", async () => {
    const html = renderToString(createElement(App));
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, createElement(App));
    });

    // Default tab is "Add MCP" — its panel shows the connect-MCP heading.
    expect(container.textContent).toContain("Connect Doco to your agent");
    expect(container.textContent).not.toContain("Existing tokens.");

    const existingTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="tokens-tab-existing"]',
    );
    expect(existingTab).not.toBeNull();

    await act(async () => {
      existingTab?.click();
    });

    // After clicking "Existing tokens", the panel must switch: the empty-state
    // line for that tab appears and the connect-MCP heading is gone.
    expect(container.textContent).toContain("No active tokens yet.");
    expect(container.textContent).not.toContain("Connect Doco to your agent");
  });
});
