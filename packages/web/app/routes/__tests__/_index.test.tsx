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

import { agentInstructions } from "~/lib/agent-instructions";
import Home, { loader } from "../_index";

async function render(): Promise<string> {
  const loaderData = await loader({ request: new Request("https://doco.test/") });
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Home, { loaderData })),
  );
}

beforeEach(() => {
  getCurrentPrincipal.mockReset();
  getCurrentPrincipal.mockResolvedValue(null);
});

describe("Home", () => {
  it("says what Doco is and hands over the agent instructions with a Copy button", async () => {
    const html = await render();
    expect(html).toContain(">Doco</h1>");
    expect(html).toContain("Shared context for AI and teams");
    expect(html).toContain("To use Doco with your agent(s), give them these instructions:");
    expect(html).toContain(">Copy</button>");
    // The instructions render verbatim (HTML-escaped) so an agent reading the
    // page compares them with its AGENTS.md copy.
    const escaped = renderToStaticMarkup(
      createElement("pre", null, agentInstructions("https://doco.test")),
    );
    expect(html).toContain(escaped.slice("<pre>".length, -"</pre>".length));
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

  it("drops the marketing sections and /llms.txt", async () => {
    const html = await render();
    expect(html).not.toContain("/llms.txt");
    expect(html).not.toContain("Create a new workspace");
    expect(html).not.toContain("Not another wiki");
  });
});
