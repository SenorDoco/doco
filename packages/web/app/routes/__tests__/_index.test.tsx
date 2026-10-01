import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { agentInstructions } from "~/lib/agent-instructions";
import Home, { loader } from "../_index";

function render(): string {
  const loaderData = loader({ request: new Request("https://doco.test/") });
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Home, { loaderData })),
  );
}

describe("Home", () => {
  it("says what Doco is and hands over the agent instructions with a Copy button", () => {
    const html = render();
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

  it("draws no header of its own: the root layout's one header sits above it", () => {
    const html = render();
    expect(html).not.toContain("<header");
    expect(html).not.toContain("Dashboard");
  });

  it("drops the marketing sections and /llms.txt", () => {
    const html = render();
    expect(html).not.toContain("/llms.txt");
    expect(html).not.toContain("Create a new workspace");
    expect(html).not.toContain("Not another wiki");
  });
});
