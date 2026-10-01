import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AGENT_INSTRUCTIONS_PATH, agentInstructions } from "~/lib/agent-instructions";
import routes from "../../routes";
import AgentsPage, { loader } from "../agents";

// Alexander, 2026-10-01: the home page no longer shows the agent
// instructions. They moved, unchanged, to /agents, where every pointer for
// agents now leads.
describe("/agents", () => {
  it("is a route of its own", () => {
    expect(AGENT_INSTRUCTIONS_PATH).toBe("/agents");
    expect(routes.find((r) => r.path === "agents")?.file).toBe("routes/agents.tsx");
  });

  it("hands over the agent instructions verbatim, with a Copy button", () => {
    const loaderData = loader({ request: new Request("https://doco.test/agents") });
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(AgentsPage, { loaderData })),
    );
    expect(html).toContain("To use Doco with your agent(s), give them these instructions:");
    expect(html).toContain(">Copy</button>");
    const escaped = renderToStaticMarkup(
      createElement("pre", null, agentInstructions("https://doco.test")),
    );
    expect(html).toContain(escaped.slice("<pre>".length, -"</pre>".length));
  });
});
