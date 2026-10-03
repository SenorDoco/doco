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
  it("shows the logo and the headline", async () => {
    const html = await render();
    expect(html).toContain(">Doco</h1>");
    expect(html).toContain("Shared context for AI and teams</p>");
  });

  // Alexander, 2026-10-03: the home page's logo is neumorphic, raised out of
  // the page like the How Doco works plate.
  it("raises the logo out of the page", async () => {
    const html = await render();
    expect(html).toMatch(/<svg[^>]*class="[^"]*\bdoco-mark-raised\b/);
  });

  // Alexander, 2026-10-02: a Get started button under the headline, saying
  // it takes a minute; then How Doco works.
  it("puts Get started under the headline, then explains how Doco works", async () => {
    const html = await render();
    const headline = html.indexOf("Shared context for AI and teams");
    const button = html.search(/<a[^>]*href="\/sign-up"[^>]*>Get started<\/a>/);
    const minute = html.indexOf("It takes just one minute");
    const howItWorks = html.indexOf("How Doco works:");
    expect(button).toBeGreaterThan(headline);
    expect(minute).toBeGreaterThan(button);
    expect(howItWorks).toBeGreaterThan(minute);
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
