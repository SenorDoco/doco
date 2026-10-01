import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The route module imports the session helper, which pulls in @doco/db at the
// top level. Stub it so the static render doesn't drag in Postgres.
const getCurrentPrincipal = vi.fn();
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: (request: Request) => getCurrentPrincipal(request),
}));

import Home, { loader } from "../_index";

async function render(): Promise<string> {
  await loader({ request: new Request("https://doco.test/") });
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Home)));
}

beforeEach(() => {
  getCurrentPrincipal.mockReset();
  getCurrentPrincipal.mockResolvedValue(null);
});

describe("Home", () => {
  it("gives the logo and the headline most of the first screen", async () => {
    const html = await render();
    expect(html).toContain(">Doco</h1>");
    // 80% of what is visible under the 3.5rem header, so only the next
    // section's title shows below it and the rest is a scroll away.
    expect(html).toMatch(
      /<div class="[^"]*min-h-\[calc\(\(100svh-3\.5rem\)\*0\.8\)\][^"]*">.*Shared context for AI and teams<\/p><\/div>/,
    );
  });

  it("then explains how Doco works", async () => {
    const html = await render();
    expect(html.indexOf("How Doco works")).toBeGreaterThan(
      html.indexOf("Shared context for AI and teams"),
    );
  });

  it("fills the other 20% with How Doco works' title alone, so its steps are a scroll away", async () => {
    const html = await render();
    expect(html).toMatch(
      /<div class="[^"]*min-h-\[calc\(\(100svh-3\.5rem\)\*0\.2\)\][^"]*"><h2[^>]*>How Doco works<\/h2><\/div>/,
    );
  });

  it("no longer hands over the agent instructions: they live at /agents", async () => {
    const html = await render();
    expect(html).not.toContain("doco:begin");
    expect(html).not.toContain("give them these instructions");
    expect(html).not.toContain(">Copy</button>");
  });

  it("sends a signed-in person to their workspaces", async () => {
    getCurrentPrincipal.mockResolvedValue({ id: "user_1", username: "ana" });
    const response = await loader({ request: new Request("https://doco.test/") }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe("/workspaces");
  });

  it("still shows the page when the session can't be looked up", async () => {
    getCurrentPrincipal.mockRejectedValue(new Error("db down"));
    const html = await render();
    expect(html).toContain("Shared context for AI and teams");
  });

  it("draws no header of its own: the root layout's one header sits above it", async () => {
    const html = await render();
    expect(html).not.toContain("<header");
    expect(html).not.toContain("Dashboard");
  });
});
