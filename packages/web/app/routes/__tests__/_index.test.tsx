import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeAll(() => {
  // VersionPill reads these vite-injected build-time globals during render;
  // vitest doesn't define them, so stub them to avoid a ReferenceError.
  vi.stubGlobal("__DOCO_VERSION__", "0.0.0-test");
  vi.stubGlobal("__DOCO_RELEASE_AT__", "2026-01-01T00:00:00.000Z");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getCurrentPrincipal.mockReset();
  getCurrentPrincipal.mockResolvedValue(null);
});

describe("Home", () => {
  it("says what Doco is and hands over the agent instructions with a Copy button", async () => {
    const html = await render();
    expect(html).toContain(">Doco</h1>");
    expect(html).toContain("Shared knowledge and context for AI and teams");
    expect(html).toContain("To use Doco with your agent(s), give them these instructions:");
    expect(html).toContain(">Copy</button>");
    // The instructions render verbatim (HTML-escaped) so an agent reading the
    // page compares them with its AGENTS.md copy.
    const escaped = renderToStaticMarkup(
      createElement("pre", null, agentInstructions("https://doco.test")),
    );
    expect(html).toContain(escaped.slice("<pre>".length, -"</pre>".length));
  });

  it("is the same simple page for a signed-in person, under the app shell's header alone", async () => {
    getCurrentPrincipal.mockResolvedValue({ id: "user_1", username: "ana" });
    const html = await render();
    expect(html).toContain("Shared knowledge and context for AI and teams");
    expect(html).not.toContain("<header");
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain('href="/sign-in"');
  });

  it("offers sign-in to a signed-out visitor", async () => {
    const html = await render();
    expect(html).toContain('href="/sign-in"');
  });

  it("drops the marketing sections and /llms.txt", async () => {
    const html = await render();
    expect(html).not.toContain("/llms.txt");
    expect(html).not.toContain("Create a new workspace");
    expect(html).not.toContain("Not another wiki");
  });
});
